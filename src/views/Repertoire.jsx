// src/views/Repertoire.jsx
import { useEffect, useState, useCallback, useRef } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import { db } from '../db/index.js'
import { syncLibrary } from '../drive/sync.js'
import { fetchPdfBytes } from '../drive/files.js'
import styles from './Repertoire.module.css'

// Set up PDF.js worker once at module level.
// The worker is copied to public/ as pdf.worker.min.mjs so it can be served
// as a plain static file — bypassing Vite's module pre-bundling, which cannot
// resolve ?url imports for packages excluded from optimizeDeps.
// The base path (/fletcher/) matches vite.config.js `base` and GitHub Pages.
pdfjsLib.GlobalWorkerOptions.workerSrc = '/fletcher/pdf.worker.min.mjs'

// ── PDF bytes cache ────────────────────────────────────────────────────────
// Keyed by Drive file ID. Avoids re-downloading when switching parts or
// revisiting a song in the same session.
const pdfBytesCache = new Map()

// ── Type colour map ────────────────────────────────────────────────────────
const TYPE_COLORS = {
  'Arrangements/Swing':   { bg: '#1A6B3C', text: '#fff' },
  'Arrangements/12 Bar':  { bg: '#1a56a0', text: '#fff' },
  'Arrangements/Bluesy':  { bg: '#5b8dd9', text: '#fff' },
  'Instrumentals/Swing':  { bg: '#ca8a04', text: '#fff' },
  'Instrumentals/12 Bar': { bg: '#c2410c', text: '#fff' },
  'Lead Sheet/Swing':     { bg: '#C0392B', text: '#fff' },
  'Lead Sheet/12 Bar':    { bg: '#7c3aed', text: '#fff' },
  'Lead Sheet/Bluesy':    { bg: '#c06090', text: '#fff' },
  'Unknown/Unknown':      { bg: '#718096', text: '#fff' },
}

function IndexBadge({ idx, songType, subtype }) {
  const key = (songType ?? 'Unknown') + '/' + (subtype ?? 'Unknown')
  const { bg, text } = TYPE_COLORS[key] ?? TYPE_COLORS['Unknown/Unknown']
  return (
    <span className={styles.badge} style={{ background: bg, color: text }}>
      {idx}
    </span>
  )
}

// ── SyncPanel ──────────────────────────────────────────────────────────────
function SyncPanel({ onSyncComplete }) {
  const [state, setState]           = useState('idle')
  const [progress, setProgress]     = useState('')
  const [stats, setStats]           = useState(null)
  const [error, setError]           = useState(null)
  const [lastSynced, setLastSynced] = useState(null)
  const [showWarnings, setShowWarnings] = useState(false)

  useEffect(() => {
    db.exec("SELECT value FROM settings WHERE key = 'last_synced'")
      .then(rows => {
        if (rows.length) setLastSynced(new Date(JSON.parse(rows[0].value)).toLocaleString())
      })
  }, [stats])

  async function handleSync() {
    setState('syncing'); setError(null); setStats(null); setShowWarnings(false)
    try {
      const result = await syncLibrary((msg, current, total) => {
        setProgress(total > 0 ? `${msg} (${current}/${total})` : msg)
      })
      setStats(result); setState('done'); onSyncComplete()
    } catch (err) {
      console.error('[Sync] Error:', err); setError(err.message); setState('error')
    }
  }

  return (
    <div className={styles.syncPanel}>
      <div className={styles.syncRow}>
        <button className={styles.syncBtn} disabled={state === 'syncing'} onClick={handleSync}>
          {state === 'syncing' ? '⏳ Syncing…' : '↻ Sync Library'}
        </button>
        {lastSynced && <span className={styles.lastSynced}>Last synced: {lastSynced}</span>}
      </div>
      {state === 'syncing' && <p className={styles.progressMsg}>{progress}</p>}
      {state === 'done' && stats && (
        <div className={styles.statsRow}>
          <span className={styles.statGreen}>+{stats.added} new</span>
          <span className={styles.statBlue}>{stats.updated} updated</span>
          {stats.inactive > 0 && <span className={styles.statGray}>{stats.inactive} inactive</span>}
          {stats.warnings.length > 0 && (
            <button className={styles.statAmber} onClick={() => setShowWarnings(w => !w)}>
              ⚠ {stats.warnings.length} warning{stats.warnings.length > 1 ? 's' : ''} {showWarnings ? '▲' : '▼'}
            </button>
          )}
        </div>
      )}
      {state === 'done' && showWarnings && stats?.warnings.length > 0 && (
        <ul className={styles.warningsList}>
          {stats.warnings.map((w, i) => <li key={i} className={styles.warningItem}>{w}</li>)}
        </ul>
      )}
      {state === 'error' && <p className={styles.errorMsg}>{error}</p>}
    </div>
  )
}

// ── PdfViewer ──────────────────────────────────────────────────────────────
// Right-side panel. Two modes, no explicit toggle:
//   details — lists available parts; clicking a part card enters pdf mode
//   pdf     — renders the part; "← Details" link returns to details mode
//
// Clicking a different song in the list remounts this component (via key prop),
// which resets to details mode automatically.
// Default part: Rhythm Guitar if available, else first.
function PdfViewer({ song }) {
  const rawParts       = JSON.parse(song.parts || '{}')
  const availableParts = Object.entries(rawParts).filter(([, id]) => !!id).map(([n]) => n)
  const missingParts   = Object.keys(rawParts).filter(n => !rawParts[n])

  const [viewMode,      setViewMode]      = useState('details')  // 'details' | 'pdf'
  const [selectedPart,  setSelectedPart]  = useState(null)  // set when user clicks a part card
  const [pdfDoc,        setPdfDoc]        = useState(null)
  const [pageNum,       setPageNum]       = useState(1)
  const [numPages,      setNumPages]      = useState(0)
  const [scale,         setScale]         = useState(1.5)
  const [loading,       setLoading]       = useState(false)
  const [error,         setError]         = useState(null)
  const [isFullscreen,  setIsFullscreen]  = useState(false)

  const canvasRef     = useRef(null)
  const wrapRef       = useRef(null)
  const renderTaskRef = useRef(null)

  // ── Reset when song changes ───────────────────────────────────────────
  useEffect(() => {
    setSelectedPart(null)
    setViewMode('details')
    setPageNum(1); setPdfDoc(null); setNumPages(0); setError(null)
  }, [song.id])  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load PDF when part or mode changes (only loads in pdf mode) ───────
  useEffect(() => {
    if (viewMode !== 'pdf' || !selectedPart) return
    const fileId = rawParts[selectedPart]
    if (!fileId) return

    let cancelled = false
    setLoading(true); setError(null); setPdfDoc(null); setPageNum(1)

    ;(async () => {
      try {
        let bytes = pdfBytesCache.get(fileId)
        if (!bytes) {
          const buf = await fetchPdfBytes(fileId)
          bytes = new Uint8Array(buf)
          pdfBytesCache.set(fileId, bytes)
        }
        if (cancelled) return
        const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise
        if (cancelled) return
        setPdfDoc(doc); setNumPages(doc.numPages); setPageNum(1)
      } catch (err) {
        if (!cancelled) setError(err.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, [song.id, selectedPart, viewMode])  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Fit-width when PDF first loads ───────────────────────────────────
  useEffect(() => {
    if (!pdfDoc || !wrapRef.current) return
    pdfDoc.getPage(1).then(page => {
      const naturalW   = page.getViewport({ scale: 1 }).width
      const containerW = wrapRef.current?.clientWidth ?? 800
      setScale((containerW - 40) / naturalW)
    })
  }, [pdfDoc])

  // ── Render page ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!pdfDoc || !canvasRef.current || viewMode !== 'pdf') return
    let cancelled = false
    if (renderTaskRef.current) { renderTaskRef.current.cancel(); renderTaskRef.current = null }

    pdfDoc.getPage(pageNum).then(page => {
      if (cancelled || !canvasRef.current) return
      const viewport = page.getViewport({ scale })
      const canvas   = canvasRef.current
      canvas.width   = viewport.width
      canvas.height  = viewport.height
      const task = page.render({ canvasContext: canvas.getContext('2d'), viewport })
      renderTaskRef.current = task
      task.promise.catch(err => {
        if (err.name !== 'RenderingCancelledException') console.error('[PdfViewer]', err)
      })
    })
    return () => { cancelled = true }
  }, [pdfDoc, pageNum, scale, viewMode])

  // ── Exit fullscreen on Escape key ─────────────────────────────────────
  useEffect(() => {
    if (!isFullscreen) return
    function onKeyDown(e) { if (e.key === 'Escape') setIsFullscreen(false) }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [isFullscreen])

  // ── Re-fit to width when fullscreen state changes ─────────────────────
  // rAF lets the browser repaint the new layout before we measure clientWidth.
  useEffect(() => {
    if (!pdfDoc || !wrapRef.current) return
    const id = requestAnimationFrame(() => {
      pdfDoc.getPage(pageNum).then(page => {
        const naturalW   = page.getViewport({ scale: 1 }).width
        const containerW = wrapRef.current?.clientWidth ?? 800
        setScale((containerW - 40) / naturalW)
      })
    })
    return () => cancelAnimationFrame(id)
  }, [isFullscreen])  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Controls ──────────────────────────────────────────────────────────
  function fitWidth() {
    if (!pdfDoc || !wrapRef.current) return
    pdfDoc.getPage(pageNum).then(page => {
      const naturalW   = page.getViewport({ scale: 1 }).width
      const containerW = wrapRef.current?.clientWidth ?? 800
      setScale((containerW - 40) / naturalW)
    })
  }

  // Open a specific part directly in PDF mode (called from the details part cards)
  function openPartInPdf(partName) {
    setSelectedPart(partName)
    setViewMode('pdf')
  }

  const prevPage = () => setPageNum(p => Math.max(1, p - 1))
  const nextPage = () => setPageNum(p => Math.min(numPages, p + 1))
  const zoomIn   = () => setScale(s => Math.min(+(s + 0.25).toFixed(2), 4))
  const zoomOut  = () => setScale(s => Math.max(+(s - 0.25).toFixed(2), 0.25))

  return (
    <div className={`${styles.viewerPane}${isFullscreen ? ` ${styles.viewerPaneFullscreen}` : ''}`}>

      {/* ── Header ──────────────────────────────────────────────────── */}
      <div className={styles.viewerHeader}>

        {/* Details mode: just the song identity */}
        {viewMode === 'details' && (
          <div className={styles.viewerTitleRow}>
            <IndexBadge idx={song.idx} songType={song.song_type} subtype={song.subtype} />
            {song.key_variant && <span className={styles.keyBadge}>{song.key_variant}</span>}
            <span className={styles.viewerSongTitle}>{song.title}</span>
          </div>
        )}

        {/* PDF mode: back link row + controls row */}
        {viewMode === 'pdf' && (
          <>
            <div className={styles.viewerTitleRow}>
              <button className={styles.backBtn} onClick={() => { setViewMode('details'); setIsFullscreen(false) }}>
                ← Details
              </button>
              <IndexBadge idx={song.idx} songType={song.song_type} subtype={song.subtype} />
              {song.key_variant && <span className={styles.keyBadge}>{song.key_variant}</span>}
              <span className={styles.viewerSongTitle}>{song.title}</span>
            </div>
            <div className={styles.viewerControls}>
              {availableParts.length > 0 ? (
                <select
                  className={styles.partSelect}
                  value={selectedPart ?? ''}
                  onChange={e => setSelectedPart(e.target.value)}
                >
                  {availableParts.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              ) : (
                <span className={styles.noPartsLabel}>No parts</span>
              )}
              <div className={styles.ctrlSep} />
              <button className={styles.ctrlBtn} onClick={prevPage} disabled={pageNum <= 1}>◄</button>
              <span className={styles.pageInfo}>{numPages > 0 ? `${pageNum} / ${numPages}` : '— / —'}</span>
              <button className={styles.ctrlBtn} onClick={nextPage} disabled={pageNum >= numPages || numPages === 0}>►</button>
              <div className={styles.ctrlSep} />
              <button className={styles.ctrlBtn} onClick={fitWidth} title="Fit to width" disabled={!pdfDoc}>⊞</button>
              <button className={styles.ctrlBtn} onClick={zoomOut} disabled={scale <= 0.25}>−</button>
              <span className={styles.zoomInfo}>{Math.round(scale * 100)}%</span>
              <button className={styles.ctrlBtn} onClick={zoomIn} disabled={scale >= 4}>+</button>
              <div className={styles.ctrlSep} />
              <button
                className={styles.ctrlBtn}
                onClick={() => setIsFullscreen(f => !f)}
                title={isFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
                disabled={!pdfDoc}
              >{isFullscreen ? '⊡' : '⛶'}</button>
            </div>
          </>
        )}
      </div>

      {/* ── Details view ────────────────────────────────────────────── */}
      {viewMode === 'details' && (
        <div className={styles.detailsView}>
          <p className={styles.detailsType}>{song.song_type} · {song.subtype}</p>

          <h3 className={styles.detailsHeading}>
            Available parts <span className={styles.detailsCount}>({availableParts.length})</span>
          </h3>

          {availableParts.length === 0 ? (
            <p className={styles.detailsEmpty}>No PDFs found in Drive folder.</p>
          ) : (
            <div className={styles.partsGrid}>
              {availableParts.map(name => (
                <button
                  key={name}
                  className={styles.partCard}
                  onClick={() => openPartInPdf(name)}
                >
                  <span className={styles.partCardName}>{name}</span>
                  <span className={styles.partCardArrow}>View PDF →</span>
                </button>
              ))}
            </div>
          )}

          {missingParts.length > 0 && (
            <>
              <h3 className={styles.detailsHeading}>
                Missing <span className={styles.detailsCount}>({missingParts.length})</span>
              </h3>
              <div className={styles.missingParts}>
                {missingParts.map(name => (
                  <span key={name} className={styles.missingPart}>{name}</span>
                ))}
              </div>
            </>
          )}

          <p className={styles.detailsMeta}>
            Drive folder: <code className={styles.detailsCode}>{song.drive_folder_id}</code>
          </p>
        </div>
      )}

      {/* ── PDF canvas area ─────────────────────────────────────────── */}
      {viewMode === 'pdf' && (
        <div className={styles.canvasWrap} ref={wrapRef}>
          {loading && (
            <div className={styles.viewerMsg}>
              <div className={styles.viewerSpinner} />
              Loading…
            </div>
          )}
          {!loading && error && <div className={styles.viewerError}>✗ {error}</div>}
          {!loading && !error && availableParts.length === 0 && (
            <div className={styles.viewerMsg}>No parts available for this song.</div>
          )}
          {!loading && !error && pdfDoc && (
            <canvas ref={canvasRef} className={styles.pdfCanvas} />
          )}
        </div>
      )}

    </div>
  )
}

// ── Repertoire (main view) ─────────────────────────────────────────────────
export default function Repertoire() {
  const [songs, setSongs]                   = useState([])
  const [loading, setLoading]               = useState(true)
  const [search, setSearch]                 = useState('')
  const [typeFilter, setTypeFilter]         = useState('All')
  const [subtypeFilter, setSubtypeFilter]   = useState('All')
  const [selectedSong, setSelectedSong]     = useState(null)

  const loadSongs = useCallback(async () => {
    setLoading(true)
    try {
      const rows = await db.exec(
        'SELECT * FROM songs WHERE active = 1 AND blacklisted = 0 ORDER BY idx ASC, key_variant ASC'
      )
      setSongs(rows)
      // Auto-select first song on initial load; preserve selection on re-sync
      if (rows.length > 0) setSelectedSong(prev => prev ?? rows[0])
    } catch (err) {
      console.error('[Repertoire] Failed to load songs:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadSongs() }, [loadSongs])

  const filtered = songs.filter(song => {
    const q = search.toLowerCase()
    const matchesSearch   = !search || song.title.toLowerCase().includes(q) || song.idx.includes(search) || song.id.toLowerCase().includes(q)
    const matchesType     = typeFilter    === 'All' || song.song_type === typeFilter
    const matchesSubtype  = subtypeFilter === 'All' || song.subtype   === subtypeFilter
    return matchesSearch && matchesType && matchesSubtype
  })

  const types    = ['All', ...new Set(songs.map(s => s.song_type).filter(Boolean))]
  const subtypes = ['All', ...new Set(songs.map(s => s.subtype).filter(Boolean))]

  // Split layout is always active once songs are loaded
  const inSplit = songs.length > 0

  return (
    <div className={inSplit ? styles.splitLayout : styles.container}>

      {/* ── Left / main pane ──────────────────────────────────────── */}
      <div className={inSplit ? styles.listPane : undefined}>

        <div className={styles.header}>
          <h2 className={styles.heading}>Repertoire</h2>
          <SyncPanel onSyncComplete={loadSongs} />
        </div>

        <div className={styles.filterBar}>
          <input
            className={styles.searchInput}
            type="text"
            placeholder="Search by title or index…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <div className={styles.filterChips}>
            {types.map(t => (
              <button
                key={t}
                className={`${styles.chip} ${typeFilter === t ? styles.chipActive : ''}`}
                onClick={() => setTypeFilter(t)}
              >{t}</button>
            ))}
          </div>
          <div className={styles.filterChips}>
            {subtypes.map(s => (
              <button
                key={s}
                className={`${styles.chip} ${subtypeFilter === s ? styles.chipActive : ''}`}
                onClick={() => setSubtypeFilter(s)}
              >{s}</button>
            ))}
          </div>
        </div>

        <p className={styles.count}>
          {loading ? 'Loading…' : songs.length === 0
            ? 'No songs yet — click ↻ Sync Library to import from Google Drive.'
            : `${filtered.length} of ${songs.length} songs`}
        </p>

        {!loading && filtered.length > 0 && (
          <div className={styles.songList}>
            {filtered.map(song => {
              const isSelected = selectedSong?.id === song.id
              return (
                <div
                  key={song.id}
                  className={`${styles.songRow} ${isSelected ? styles.songRowSelected : ''} ${inSplit ? styles.songRowCompact : ''}`}
                  onClick={() => setSelectedSong(song)}
                >
                  <IndexBadge idx={song.idx} songType={song.song_type} subtype={song.subtype} />
                  {song.key_variant && <span className={styles.keyBadge}>{song.key_variant}</span>}
                  <span className={styles.songTitle}>{song.title}</span>
                  {!inSplit && <span className={styles.songMeta}>{song.song_type} / {song.subtype}</span>}
                  {!inSplit && (
                    <span className={styles.partCount}>
                      {Object.keys(JSON.parse(song.parts || '{}')).length} parts
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ── PDF viewer pane — always mounted once a song is selected ── */}
      {selectedSong && (
        <PdfViewer
          key={selectedSong.id}
          song={selectedSong}
        />
      )}

    </div>
  )
}
