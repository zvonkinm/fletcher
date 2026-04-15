// src/views/Repertoire.jsx
import React, { useEffect, useState, useCallback } from 'react'
import { db } from '../db/index.js'
import { syncLibrary } from '../drive/sync.js'
import styles from './Repertoire.module.css'

// ── Type colour map ────────────────────────────────────────────────────────
// Maps "Type/Subtype" → background + text colour for the index badge.
// Colours match the original Google Colab notebook's colour scheme.
const TYPE_COLORS = {
  'Arrangements/Swing':   { bg: '#1A6B3C', text: '#fff' },
  'Arrangements/12 Bar':  { bg: '#1a56a0', text: '#fff' },
  'Arrangements/Bluesy':  { bg: '#5b8dd9', text: '#fff' },
  'Instrumentals/Swing':  { bg: '#b7791f', text: '#fff' },
  'Instrumentals/12 Bar': { bg: '#7b3fa0', text: '#fff' },
  'Lead Sheet/Swing':     { bg: '#C0392B', text: '#fff' },
  'Lead Sheet/12 Bar':    { bg: '#e07070', text: '#fff' },
  'Lead Sheet/Bluesy':    { bg: '#c06090', text: '#fff' },
  'Unknown/Unknown':      { bg: '#718096', text: '#fff' },
}

// ── IndexBadge ─────────────────────────────────────────────────────────────
// Coloured pill showing the 4-digit song index.
// Colour is determined by song type + subtype.
function IndexBadge({ idx, songType, subtype }) {
  const key = songType + '/' + subtype
  const colors = TYPE_COLORS[key] || TYPE_COLORS['Unknown/Unknown']
  return (
    // style= is still used here because the colour is dynamic (data-driven),
    // which CSS Modules can't handle on its own.
    <span className={styles.badge} style={{ background: colors.bg, color: colors.text }}>
      {idx}
    </span>
  )
}

// ── SyncPanel ──────────────────────────────────────────────────────────────
// The "↻ Sync Library" button + progress/result display.
// onSyncComplete is called after a successful sync so the song list reloads.
function SyncPanel({ onSyncComplete }) {
  const [state, setState] = useState('idle') // idle | syncing | done | error
  const [progress, setProgress] = useState('')
  const [stats, setStats] = useState(null)
  const [error, setError] = useState(null)
  const [lastSynced, setLastSynced] = useState(null)
  const [showWarnings, setShowWarnings] = useState(false)

  // Load the last-synced timestamp from the DB on mount and after each sync
  useEffect(() => {
    db.exec("SELECT value FROM settings WHERE key = 'last_synced'")
      .then(rows => {
        if (rows.length) {
          // JSON.parse unwraps the stored number, then we format it as a local date string
          setLastSynced(new Date(JSON.parse(rows[0].value)).toLocaleString())
        }
      })
  }, [stats]) // re-run when stats changes (i.e. after a sync completes)

  async function handleSync() {
    setState('syncing')
    setError(null)
    setStats(null)
    setShowWarnings(false)
    try {
      // syncLibrary accepts a progress callback that fires on each folder scanned
      const result = await syncLibrary((msg, current, total) => {
        setProgress(total > 0 ? msg + ' (' + current + '/' + total + ')' : msg)
      })
      setStats(result)
      setState('done')
      onSyncComplete() // tell Repertoire to reload its song list
    } catch (err) {
      console.error('[Sync] Error:', err)
      setError(err.message)
      setState('error')
    }
  }

  return (
    <div className={styles.syncPanel}>
      <div className={styles.syncRow}>
        <button
          className={styles.syncBtn}
          disabled={state === 'syncing'}
          onClick={handleSync}
        >
          {state === 'syncing' ? '⏳ Syncing…' : '↻ Sync Library'}
        </button>
        {lastSynced && (
          <span className={styles.lastSynced}>Last synced: {lastSynced}</span>
        )}
      </div>

      {/* Progress message shown while syncing */}
      {state === 'syncing' && (
        <p className={styles.progressMsg}>{progress}</p>
      )}

      {/* Stats summary shown after a successful sync */}
      {state === 'done' && stats && (
        <div className={styles.statsRow}>
          <span className={styles.statGreen}>+{stats.added} new</span>
          <span className={styles.statBlue}>{stats.updated} updated</span>
          {stats.inactive > 0 && (
            <span className={styles.statGray}>{stats.inactive} inactive</span>
          )}
          {/* Warnings are shown as a clickable count that expands a list */}
          {stats.warnings.length > 0 && (
            <button
              className={styles.statAmber}
              onClick={() => setShowWarnings(w => !w)}
            >
              ⚠ {stats.warnings.length} warning{stats.warnings.length > 1 ? 's' : ''} {showWarnings ? '▲' : '▼'}
            </button>
          )}
        </div>
      )}
      {/* Expanded warnings list */}
      {state === 'done' && showWarnings && stats?.warnings.length > 0 && (
        <ul className={styles.warningsList}>
          {stats.warnings.map((w, i) => (
            <li key={i} className={styles.warningItem}>{w}</li>
          ))}
        </ul>
      )}

      {state === 'error' && (
        <p className={styles.errorMsg}>{error}</p>
      )}
    </div>
  )
}

// ── SongDetail ─────────────────────────────────────────────────────────────
// Modal overlay showing full details of a selected song.
// Clicking the overlay background or the ✕ button closes it.
function SongDetail({ song, onClose }) {
  if (!song) return null

  // song.parts is stored as a JSON string in SQLite — parse it back to an object
  const parts = JSON.parse(song.parts || '{}')
  const partNames = Object.keys(parts)

  return (
    // Clicking the dark overlay (but not the white panel) closes the modal
    <div className={styles.detailOverlay} onClick={onClose}>
      <div className={styles.detailPanel} onClick={e => e.stopPropagation()}>
        <div className={styles.detailHeader}>
          <IndexBadge idx={song.idx} songType={song.song_type} subtype={song.subtype} />
          {/* Only show key badge if this is a key variant (e.g. "in Am") */}
          {song.key_variant && (
            <span className={styles.keyBadge}>{song.key_variant}</span>
          )}
          <h2 className={styles.detailTitle}>{song.title}</h2>
          <button className={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        <p className={styles.detailType}>{song.song_type} / {song.subtype}</p>

        <h3 className={styles.partsHeading}>
          Available parts ({partNames.length})
        </h3>

        {partNames.length === 0 ? (
          <p className={styles.noParts}>No PDFs found in Drive folder.</p>
        ) : (
          <ul className={styles.partsList}>
            {/* Sort alphabetically for consistent display */}
            {partNames.sort().map(name => (
              <li key={name} className={styles.partItem}>
                <span className={styles.partName}>{name}</span>
              </li>
            ))}
          </ul>
        )}

        <p className={styles.detailMeta}>
          Drive folder ID: <code className={styles.code}>{song.drive_folder_id}</code>
        </p>
      </div>
    </div>
  )
}

// ── Repertoire (main view) ─────────────────────────────────────────────────
export default function Repertoire() {
  const [songs, setSongs]               = useState([])
  const [loading, setLoading]           = useState(true)
  const [search, setSearch]             = useState('')
  const [typeFilter, setTypeFilter]     = useState('All')
  const [subtypeFilter, setSubtypeFilter] = useState('All')
  const [selectedSong, setSelectedSong] = useState(null)

  // Load all non-blacklisted, active songs from SQLite.
  // useCallback memoises this function so it can be passed to SyncPanel
  // without causing infinite re-renders.
  const loadSongs = useCallback(async () => {
    setLoading(true)
    try {
      const rows = await db.exec(
        'SELECT * FROM songs WHERE active = 1 AND blacklisted = 0 ORDER BY idx ASC, key_variant ASC'
      )
      setSongs(rows)
    } catch (err) {
      console.error('[Repertoire] Failed to load songs:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  // Load songs once when the component mounts
  useEffect(() => { loadSongs() }, [loadSongs])

  // ── Client-side filtering ──────────────────────────────────────────────
  // All filtering happens in memory — no DB queries on each keystroke.
  const filtered = songs.filter(song => {
    const q = search.toLowerCase()
    const matchesSearch = !search ||
      song.title.toLowerCase().includes(q) ||
      song.idx.includes(search) ||
      song.id.toLowerCase().includes(q)
    const matchesType    = typeFilter === 'All'    || song.song_type === typeFilter
    const matchesSubtype = subtypeFilter === 'All' || song.subtype   === subtypeFilter
    return matchesSearch && matchesType && matchesSubtype
  })

  // Build unique filter chip values from the loaded songs (not hardcoded)
  const types    = ['All', ...new Set(songs.map(s => s.song_type).filter(Boolean))]
  const subtypes = ['All', ...new Set(songs.map(s => s.subtype).filter(Boolean))]

  return (
    <div className={styles.container}>
      {/* Top bar: heading + sync panel */}
      <div className={styles.header}>
        <h2 className={styles.heading}>Repertoire</h2>
        <SyncPanel onSyncComplete={loadSongs} />
      </div>

      {/* Search + filter chips */}
      <div className={styles.filterBar}>
        <input
          className={styles.searchInput}
          type="text"
          placeholder="Search by title or index…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        {/* Type filter chips (Arrangements / Instrumentals / Lead Sheet) */}
        <div className={styles.filterChips}>
          {types.map(t => (
            <button
              key={t}
              className={`${styles.chip} ${typeFilter === t ? styles.chipActive : ''}`}
              onClick={() => setTypeFilter(t)}
            >
              {t}
            </button>
          ))}
        </div>
        {/* Subtype filter chips (Swing / 12 Bar / Bluesy) */}
        <div className={styles.filterChips}>
          {subtypes.map(s => (
            <button
              key={s}
              className={`${styles.chip} ${subtypeFilter === s ? styles.chipActive : ''}`}
              onClick={() => setSubtypeFilter(s)}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Result count */}
      <p className={styles.count}>
        {loading ? 'Loading…' : songs.length === 0
          ? 'No songs yet — click ↻ Sync Library to import from Google Drive.'
          : filtered.length + ' of ' + songs.length + ' songs'}
      </p>

      {/* Song rows */}
      {!loading && filtered.length > 0 && (
        <div className={styles.songList}>
          {filtered.map(song => (
            <div
              key={song.id}
              className={styles.songRow}
              onClick={() => setSelectedSong(song)}
            >
              <IndexBadge idx={song.idx} songType={song.song_type} subtype={song.subtype} />
              {song.key_variant && (
                <span className={styles.keyBadge}>{song.key_variant}</span>
              )}
              <span className={styles.songTitle}>{song.title}</span>
              <span className={styles.songMeta}>{song.song_type} / {song.subtype}</span>
              <span className={styles.partCount}>
                {Object.keys(JSON.parse(song.parts || '{}')).length} parts
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Song detail modal */}
      {selectedSong && (
        <SongDetail
          song={selectedSong}
          onClose={() => setSelectedSong(null)}
        />
      )}
    </div>
  )
}