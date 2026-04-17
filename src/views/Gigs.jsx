// src/views/Gigs.jsx
// Step 3: Gig Builder
//
// Two screens, selected by URL parameter:
//   /gigs          → GigList:   all gigs sorted by date
//   /gigs/:gigId   → GigEditor: multi-set drag-and-drop setlist builder
//
// A gig contains N named sets. Each set is an ordered list of songs.
// A song may not appear more than once across all sets of the same gig.
import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  DndContext,
  DragOverlay,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  useDraggable,
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { db } from '../db/index.js'
import { exportGig } from '../drive/export.js'
import { tokenExpiresIn, refreshAccessToken } from '../auth/google.js'
import styles from './Gigs.module.css'

// ── Type colour map ─────────────────────────────────────────────────────────
// Same as Repertoire — maps "Type/Subtype" to badge background + text colour.
const TYPE_COLORS = {
  'Arrangements/Swing':   { bg: '#1A6B3C', text: '#fff' },  // 10xx green
  'Arrangements/12 Bar':  { bg: '#1a56a0', text: '#fff' },  // 11xx blue
  'Arrangements/Bluesy':  { bg: '#5b8dd9', text: '#fff' },  // 12xx
  'Instrumentals/Swing':  { bg: '#ca8a04', text: '#fff' },  // 20xx yellow
  'Instrumentals/12 Bar': { bg: '#c2410c', text: '#fff' },  // 21xx orange
  'Lead Sheet/Swing':     { bg: '#C0392B', text: '#fff' },  // 30xx red
  'Lead Sheet/12 Bar':    { bg: '#7c3aed', text: '#fff' },  // 31xx purple
  'Lead Sheet/Bluesy':    { bg: '#c06090', text: '#fff' },  // 32xx
  'Unknown/Unknown':      { bg: '#718096', text: '#fff' },
}

// Coloured pill showing a 4-digit index; colour driven by type + subtype.
function IndexBadge({ idx, songType, subtype }) {
  const key = (songType ?? 'Unknown') + '/' + (subtype ?? 'Unknown')
  const { bg, text } = TYPE_COLORS[key] ?? TYPE_COLORS['Unknown/Unknown']
  return (
    <span className={styles.badge} style={{ background: bg, color: text }}>
      {idx}
    </span>
  )
}

// ── Utility helpers ─────────────────────────────────────────────────────────

// Returns a short random alphanumeric string. Used for client-side set IDs
// and entry IDs — these are never written directly to the DB.
function newId() {
  return Math.random().toString(36).slice(2, 10)
}

// Turns a gig name + ISO date into a URL-safe slug used as the gig's DB id.
// Example: ("VTJB Highball", "2026-04-01") → "vtjb_highball_260401"
function generateSlug(name, date) {
  const namePart = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')  // replace non-alphanumeric runs with _
    .replace(/^_|_$/g, '')         // trim leading/trailing underscores
    .slice(0, 22)
  // "2026-04-01" → strip dashes → "20260401" → last 6 chars → "260401"
  const datePart = (date || '').replace(/-/g, '').slice(2)
  return namePart + '_' + datePart
}

// Formats an ISO date string ("2026-04-01") as "1 Apr 2026".
// Appending T00:00:00 prevents UTC midnight from shifting the date
// back one day in western (negative-offset) timezones.
function formatDate(iso) {
  if (!iso) return '—'
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

// ── Sets serialisation ──────────────────────────────────────────────────────

// Converts the stored setlist JSON to the internal working state format:
//   [{ id, name, entries: [{ entryId, songId }] }]
//
// Handles two storage formats:
//   Legacy  — flat string array: ["1025", "1023#Am"]
//             (seeded gigs use this; treated as a single "Set 1")
//   Current — set-objects array: [{ id, name, song_ids: ["1025", ...] }]
//
// entryId is a fresh client-side ID added on every load; it is never saved.
function parseStoredSets(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    // Nothing stored yet — start with one empty set
    return [{ id: newId(), name: 'Set 1', entries: [] }]
  }

  if (typeof raw[0] === 'string') {
    // Legacy flat format — migrate in-memory to a single set
    return [{
      id: newId(),
      name: 'Set 1',
      entries: raw.map(songId => ({ entryId: newId(), songId })),
    }]
  }

  // Current format: [{id, name, song_ids}]
  return raw.map(set => ({
    id:      set.id   || newId(),
    name:    set.name || 'Set',
    entries: (set.song_ids || []).map(songId => ({ entryId: newId(), songId })),
  }))
}

// Strips client-side entryIds and converts internal state back to storage format.
function setsToStorage(sets) {
  return sets.map(({ id, name, entries }) => ({
    id,
    name,
    song_ids: entries.map(e => e.songId),
  }))
}

// Returns the id of the set that contains the given entryId, or null.
function findEntrySetId(sets, entryId) {
  for (const set of sets) {
    if (set.entries.some(e => e.entryId === entryId)) return set.id
  }
  return null
}

// ── GigList ─────────────────────────────────────────────────────────────────
// Shows all gigs as clickable cards sorted by date descending.
// Clicking "+ New Gig" opens GigForm.
function GigList() {
  const navigate = useNavigate()
  const [gigs, setGigs]         = useState(null)
  const [showForm, setShowForm] = useState(false)

  const loadGigs = useCallback(async () => {
    try {
      const rows = await db.exec(
        'SELECT id, name, band_name, date, time, venue, setlist, locked ' +
        'FROM gigs ORDER BY date DESC, name ASC'
      )
      setGigs(rows)
    } catch (err) {
      console.error('[Gigs] Failed to load gigs:', err)
    }
  }, [])

  useEffect(() => { loadGigs() }, [loadGigs])

  // Total song count across all sets (handles both legacy + current format).
  function totalSongs(setlistJson) {
    try {
      const raw = JSON.parse(setlistJson || '[]')
      if (raw.length === 0) return 0
      if (typeof raw[0] === 'string') return raw.length
      return raw.reduce((n, s) => n + (s.song_ids?.length ?? 0), 0)
    } catch { return 0 }
  }

  // Number of sets stored in a gig's setlist JSON.
  function totalSets(setlistJson) {
    try {
      const raw = JSON.parse(setlistJson || '[]')
      if (raw.length === 0) return 0
      if (typeof raw[0] === 'string') return 1
      return raw.length
    } catch { return 0 }
  }

  function handleGigCreated(gigId) {
    setShowForm(false)
    navigate('/gigs/' + gigId)
  }

  return (
    <div className={styles.listContainer}>
      <div className={styles.listHeader}>
        <h2 className={styles.heading}>Gigs</h2>
        <button className={styles.primaryBtn} onClick={() => setShowForm(true)}>
          + New Gig
        </button>
      </div>

      {showForm && (
        <GigForm
          existingGigs={gigs || []}
          onSave={handleGigCreated}
          onCancel={() => setShowForm(false)}
        />
      )}

      {gigs === null && <p className={styles.muted}>Loading…</p>}
      {gigs?.length === 0 && !showForm && (
        <p className={styles.muted}>No gigs yet — click "+ New Gig" to create one.</p>
      )}

      {gigs && gigs.length > 0 && (
        <div className={styles.gigCards}>
          {gigs.map(gig => {
            const nSets  = totalSets(gig.setlist)
            const nSongs = totalSongs(gig.setlist)
            return (
              <div
                key={gig.id}
                className={styles.gigCard}
                onClick={() => navigate('/gigs/' + gig.id)}
              >
                <div className={styles.gigCardTop}>
                  <span className={styles.gigName}>{gig.name}</span>
                  {gig.band_name && (
                    <span className={styles.gigBand}>{gig.band_name}</span>
                  )}
                  {gig.locked === 1 && (
                    <span className={styles.lockBadge} title="Locked">🔒</span>
                  )}
                </div>
                <div className={styles.gigCardMeta}>
                  <span>{formatDate(gig.date)}</span>
                  {gig.time  && <span>· {gig.time}</span>}
                  {gig.venue && <span>· {gig.venue}</span>}
                </div>
                <div className={styles.gigCardStats}>
                  {nSets} set{nSets !== 1 ? 's' : ''} · {nSongs} song{nSongs !== 1 ? 's' : ''}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── GigForm ──────────────────────────────────────────────────────────────────
// Modal for creating a new gig.
// Props:
//   existingGigs   — array of all gig rows, used for the "copy sets from" dropdown
//   onSave(gigId)  — called with the new gig's slug ID after inserting into DB
//   onCancel()     — close without saving
function GigForm({ existingGigs, onSave, onCancel }) {
  const [gigName, setGigName]   = useState('')
  const [bandName, setBandName] = useState('')
  const [date, setDate]         = useState('')
  const [time, setTime]         = useState('')
  const [venue, setVenue]       = useState('')
  // gigId of an existing gig to copy sets from (empty string = start fresh)
  const [copyFrom, setCopyFrom] = useState('')
  const [saving, setSaving]     = useState(false)
  const [error, setError]       = useState(null)

  async function handleSubmit(e) {
    e.preventDefault()
    if (!gigName.trim() || !date) {
      setError('Gig name and date are required.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      // Generate slug; append 4-char random suffix if a collision exists
      let gigId = generateSlug(gigName.trim(), date)
      const existing = await db.exec('SELECT id FROM gigs WHERE id = ?', [gigId])
      if (existing.length > 0) gigId += '_' + newId().slice(0, 4)

      // If copying sets from another gig, load that gig's setlist now
      let initialSetsJson = JSON.stringify([{ id: newId(), name: 'Set 1', song_ids: [] }])
      if (copyFrom) {
        const sourceRows = await db.exec(
          'SELECT setlist FROM gigs WHERE id = ?', [copyFrom]
        )
        if (sourceRows.length > 0) {
          const sourceSets = parseStoredSets(JSON.parse(sourceRows[0].setlist || '[]'))
          // Assign fresh IDs so the copy is fully independent from the source
          const copied = sourceSets.map(s => ({
            id:       newId(),
            name:     s.name,
            song_ids: s.entries.map(e => e.songId),
          }))
          initialSetsJson = JSON.stringify(copied)
        }
      }

      await db.run(
        `INSERT INTO gigs (id, name, band_name, date, time, venue, setlist, print_sublists)
         VALUES (?, ?, ?, ?, ?, ?, ?, '[]')`,
        [
          gigId,
          gigName.trim(),
          bandName.trim() || null,
          date,
          time.trim()  || null,
          venue.trim() || null,
          initialSetsJson,
        ]
      )
      onSave(gigId)
    } catch (err) {
      console.error('[Gigs] Failed to create gig:', err)
      setError(err.message)
      setSaving(false)
    }
  }

  // Close modal when clicking the dark overlay (but not the white card)
  function handleOverlayClick(e) {
    if (e.target === e.currentTarget) onCancel()
  }

  return (
    <div className={styles.modalOverlay} onClick={handleOverlayClick}>
      <div className={styles.modalPanel}>
        <h3 className={styles.modalTitle}>New Gig</h3>
        <form onSubmit={handleSubmit} className={styles.form}>

          <label className={styles.formLabel}>
            Gig name *
            <input
              className={styles.formInput}
              value={gigName}
              onChange={e => setGigName(e.target.value)}
              placeholder="e.g. VTJB Highball"
              autoFocus
            />
          </label>

          <label className={styles.formLabel}>
            Band name
            <input
              className={styles.formInput}
              value={bandName}
              onChange={e => setBandName(e.target.value)}
              placeholder="e.g. The Vintage Ties"
            />
          </label>

          {/* Date and time sit side-by-side */}
          <div className={styles.formRow}>
            <label className={styles.formLabel} style={{ flex: 1 }}>
              Date *
              <input
                className={styles.formInput}
                type="date"
                value={date}
                onChange={e => setDate(e.target.value)}
              />
            </label>
            <label className={styles.formLabel} style={{ flex: 1 }}>
              Time
              <input
                className={styles.formInput}
                value={time}
                onChange={e => setTime(e.target.value)}
                placeholder="e.g. 7:30 PM"
              />
            </label>
          </div>

          <label className={styles.formLabel}>
            Venue
            <input
              className={styles.formInput}
              value={venue}
              onChange={e => setVenue(e.target.value)}
              placeholder="e.g. The Highball, Austin TX"
            />
          </label>

          {/* Copy-from dropdown: only shown when there are existing gigs */}
          {existingGigs.length > 0 && (
            <label className={styles.formLabel}>
              Pre-populate sets from (optional)
              <select
                className={styles.formInput}
                value={copyFrom}
                onChange={e => setCopyFrom(e.target.value)}
              >
                <option value="">— start empty —</option>
                {existingGigs.map(g => (
                  <option key={g.id} value={g.id}>
                    {g.name} ({formatDate(g.date)})
                  </option>
                ))}
              </select>
            </label>
          )}

          {error && <p className={styles.formError}>{error}</p>}

          <div className={styles.formActions}>
            <button type="button" className={styles.ghostBtn} onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className={styles.primaryBtn} disabled={saving}>
              {saving ? 'Creating…' : 'Create Gig'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── DraggableSong ────────────────────────────────────────────────────────────
// One song row in the left (Repertoire) panel.
// When isUsed=true the song is already in one of the gig's sets:
//   - drag is disabled
//   - a ✓ badge replaces the "+" button
//   - row is visually dimmed
function DraggableSong({ song, isUsed, isLocked, onAdd }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id:       'repo::' + song.id,
    data:     { type: 'song', song },
    // Disable drag when the song is already in the gig, or when the gig is locked
    disabled: isUsed || isLocked,
  })

  return (
    <div
      ref={setNodeRef}
      className={[
        styles.repoRow,
        isDragging ? styles.repoRowDragging : '',
        isUsed     ? styles.repoRowUsed    : '',
      ].filter(Boolean).join(' ')}
      {...listeners}
      {...attributes}
    >
      <IndexBadge idx={song.idx} songType={song.song_type} subtype={song.subtype} />
      {song.key_variant && (
        <span className={styles.keyBadge}>{song.key_variant}</span>
      )}
      <span className={styles.repoTitle}>{song.title}</span>
      {/* Show ✓ when already used; show + when available and unlocked; show nothing when locked */}
      {isUsed ? (
        <span className={styles.usedMark} title="Already in this gig">✓</span>
      ) : !isLocked ? (
        <button
          className={styles.addBtn}
          title="Add to Set 1"
          onPointerDown={e => e.stopPropagation()}
          onClick={e => { e.stopPropagation(); onAdd(song.id) }}
        >
          +
        </button>
      ) : null}
    </div>
  )
}

// ── SetEntry ─────────────────────────────────────────────────────────────────
// One song row inside a set column. Sortable — can be dragged to reorder
// within its set or moved to a different set.
// Props:
//   entry    — { entryId, songId }
//   song     — song object from DB, or null if not yet synced from Drive
//   position — 1-based position number displayed to the left of the badge
//   isLocked — when true, drag is disabled and the remove button is hidden
//   onRemove(entryId) — called when the × button is clicked
function SetEntry({ entry, song, position, isLocked, onRemove }) {
  const {
    attributes, listeners, setNodeRef,
    transform, transition, isDragging,
  } = useSortable({
    id:       entry.entryId,
    data:     { type: 'entry', entryId: entry.entryId },
    disabled: isLocked,  // dnd-kit won't activate drag when the gig is locked
  })

  // CSS.Transform.toString() converts dnd-kit's transform object to a CSS
  // translate3d(...) string. transition is supplied by dnd-kit to animate
  // the snap-back when a drag is cancelled or completed.
  const style = {
    transform:  CSS.Transform.toString(transform),
    transition,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`${styles.setEntry} ${isDragging ? styles.setEntryDragging : ''}`}
    >
      {/* Drag handle — hidden when locked so the row looks purely read-only */}
      {!isLocked && (
        <span
          className={styles.dragHandle}
          {...listeners}
          {...attributes}
          title="Drag to reorder or move to another set"
        >
          ⠿
        </span>
      )}

      <span className={styles.entryPos}>{position}</span>

      {song ? (
        <>
          <IndexBadge idx={song.idx} songType={song.song_type} subtype={song.subtype} />
          {song.key_variant && (
            <span className={styles.keyBadge}>{song.key_variant}</span>
          )}
          <span className={styles.entryTitle}>{song.title}</span>
        </>
      ) : (
        // Song not in local DB — shown when Drive hasn't been synced yet
        <span className={styles.entryUnknown}>{entry.songId}</span>
      )}

      {/* Remove button — hidden when the gig is locked */}
      {!isLocked && (
        <button
          className={styles.removeBtn}
          onClick={() => onRemove(entry.entryId)}
          onPointerDown={e => e.stopPropagation()}
          title="Remove from set"
        >
          ×
        </button>
      )}
    </div>
  )
}

// ── SetColumn ────────────────────────────────────────────────────────────────
// One set column in the sets area.
// Uses useDroppable so songs can be dropped even when the column is empty
// (no sortable items means closestCenter won't find any targets otherwise).
// Props:
//   set            — { id, name, entries[] }
//   songMap        — Map<songId → song object>
//   isSongDragging — true when a repertoire song is currently being dragged
//   onRename(setId, name)
//   onRemoveEntry(setId, entryId)
//   onDelete(setId)
function SetColumn({ set, songMap, isSongDragging, isLocked, onRename, onRemoveEntry, onDelete }) {
  // When locked, dropping is still registered by useDroppable but handleDragEnd
  // in GigEditor checks isLocked before mutating state, so drops are no-ops.
  const { setNodeRef, isOver } = useDroppable({ id: 'set-col-' + set.id })

  // Local state for the inline rename input
  const [editing, setEditing]   = useState(false)
  const [nameVal, setNameVal]   = useState(set.name)

  // Keep local nameVal in sync if the parent renames the set (e.g. after add)
  useEffect(() => { setNameVal(set.name) }, [set.name])

  function commitRename() {
    setEditing(false)
    const trimmed = nameVal.trim()
    if (trimmed && trimmed !== set.name) {
      onRename(set.id, trimmed)
    } else {
      setNameVal(set.name)  // revert if empty or unchanged
    }
  }

  return (
    <div className={styles.setColumn}>

      {/* ── Column header: name, count, delete ──────────────────────── */}
      <div className={styles.setColumnHeader}>
        {/* Set name: click-to-rename when unlocked, plain text when locked */}
        {editing ? (
          <input
            className={styles.setNameInput}
            value={nameVal}
            onChange={e => setNameVal(e.target.value)}
            onBlur={commitRename}
            onKeyDown={e => {
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') { setEditing(false); setNameVal(set.name) }
            }}
            autoFocus
          />
        ) : (
          <span
            className={styles.setName}
            onClick={isLocked ? undefined : () => setEditing(true)}
            title={isLocked ? undefined : 'Click to rename'}
            style={isLocked ? { cursor: 'default' } : undefined}
          >
            {set.name}
          </span>
        )}
        <span className={styles.setCount}>{set.entries.length}</span>
        {/* Delete button hidden when locked */}
        {!isLocked && (
          <button
            className={styles.removeBtn}
            onClick={() => onDelete(set.id)}
            onPointerDown={e => e.stopPropagation()}
            title="Delete this set"
          >
            ×
          </button>
        )}
      </div>

      {/* ── Droppable body + sortable entries ───────────────────────── */}
      {/* setNodeRef makes the whole column body a drop target so that
          dropping onto an empty column registers correctly with dnd-kit. */}
      <div
        ref={setNodeRef}
        className={[
          styles.setColumnBody,
          // Highlight when a repertoire song is dragged and this column is over
          (isSongDragging && isOver) ? styles.setColumnBodyOver : '',
        ].filter(Boolean).join(' ')}
      >
        <SortableContext
          items={set.entries.map(e => e.entryId)}
          strategy={verticalListSortingStrategy}
        >
          {set.entries.length === 0 && (
            <p className={styles.emptyHint}>
              {isSongDragging ? 'Drop here' : 'Drag songs here'}
            </p>
          )}
          {set.entries.map((entry, i) => (
            <SetEntry
              key={entry.entryId}
              entry={entry}
              song={songMap.get(entry.songId) ?? null}
              position={i + 1}
              isLocked={isLocked}
              onRemove={entryId => onRemoveEntry(set.id, entryId)}
            />
          ))}
        </SortableContext>
      </div>
    </div>
  )
}

// ── GigEditor ────────────────────────────────────────────────────────────────
// The full setlist editor for one gig.
// Left panel:   searchable repertoire, each song draggable
// Right area:   horizontal row of set columns (each droppable + sortable)
function GigEditor({ gigId }) {
  const navigate = useNavigate()

  // ── State ────────────────────────────────────────────────────────────
  const [gig, setGig]               = useState(null)
  const [notFound, setNotFound]     = useState(false)
  const [sets, setSets]             = useState([])
  const [songs, setSongs]           = useState([])
  const [songMap, setSongMap]       = useState(new Map())
  const [search, setSearch]         = useState('')
  const [meta, setMeta]             = useState({
    name: '', band_name: '', date: '', time: '', venue: '',
  })
  const [saveStatus, setSaveStatus] = useState('saved')  // 'saved'|'saving'|'error'
  const [activeDrag, setActiveDrag] = useState(null)     // for DragOverlay
  const [showDelete, setShowDelete] = useState(false)
  // isLocked: true = read-only; toggled by the lock button; saved immediately
  const [isLocked, setIsLocked]     = useState(true)     // default locked until loaded
  // parts: which instruments are active for this gig (persisted to gigs.parts)
  const [parts, setParts]               = useState([])
  const [activePartsDef, setActivePartsDef] = useState([])  // from settings.active_parts
  // export panel state
  const [exportOpen, setExportOpen]     = useState(false)
  const [exportLog, setExportLog]       = useState([])
  const [exporting, setExporting]       = useState(false)
  const [exportDone, setExportDone]     = useState(false)
  const [exportStage, setExportStage] = useState({ label: '', done: 0, total: 0 })
  // repoVisible: controls whether the left Repertoire panel is shown
  const [repoVisible, setRepoVisible]   = useState(true)

  // loadedRef prevents auto-save effects from firing during the initial load
  const loadedRef   = useRef(false)
  const setsSaveRef = useRef(null)
  const metaSaveRef = useRef(null)

  // ── Load gig + songs ─────────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      loadedRef.current = false
      try {
        const rows = await db.exec('SELECT * FROM gigs WHERE id = ?', [gigId])
        if (rows.length === 0) { setNotFound(true); return }

        const row = rows[0]
        setGig(row)
        setMeta({
          name:      row.name      ?? '',
          band_name: row.band_name ?? '',
          date:      row.date      ?? '',
          time:      row.time      ?? '',
          venue:     row.venue     ?? '',
        })
        // locked is stored as INTEGER 0/1; treat any non-zero value as locked
        setIsLocked(row.locked !== 0)
        setSets(parseStoredSets(JSON.parse(row.setlist || '[]')))

        // Load per-gig parts; fall back to active_parts from settings
        const partRows = await db.exec(`SELECT value FROM settings WHERE key = 'active_parts'`)
        const defaultParts = partRows.length > 0 ? JSON.parse(partRows[0].value) : []
        setActivePartsDef(defaultParts)
        setParts(row.parts ? JSON.parse(row.parts) : defaultParts)

        // Load the full repertoire for the left panel
        const allSongs = await db.exec(
          'SELECT id, idx, key_variant, title, song_type, subtype ' +
          'FROM songs WHERE active = 1 AND blacklisted = 0 ' +
          'ORDER BY idx ASC, key_variant ASC'
        )
        setSongs(allSongs)
        setSongMap(new Map(allSongs.map(s => [s.id, s])))

        loadedRef.current = true
      } catch (err) {
        console.error('[Gigs] Load failed:', err)
      }
    }
    load()
  }, [gigId])

  // ── Auto-save sets ────────────────────────────────────────────────────
  // Debounced 600ms after any change to sets. Skips the initial load.
  useEffect(() => {
    if (!loadedRef.current) return
    setSaveStatus('saving')
    clearTimeout(setsSaveRef.current)
    setsSaveRef.current = setTimeout(async () => {
      try {
        await db.run(
          'UPDATE gigs SET setlist = ? WHERE id = ?',
          [JSON.stringify(setsToStorage(sets)), gigId]
        )
        setSaveStatus('saved')
      } catch (err) {
        console.error('[Gigs] Sets save failed:', err)
        setSaveStatus('error')
      }
    }, 600)
    return () => clearTimeout(setsSaveRef.current)
  }, [sets, gigId])

  // ── Auto-save metadata ────────────────────────────────────────────────
  // Separate debounce so name/date edits don't reset the sets save timer.
  useEffect(() => {
    if (!loadedRef.current) return
    clearTimeout(metaSaveRef.current)
    metaSaveRef.current = setTimeout(async () => {
      try {
        await db.run(
          'UPDATE gigs SET name=?, band_name=?, date=?, time=?, venue=? WHERE id=?',
          [
            meta.name      || '(untitled)',
            meta.band_name || null,
            meta.date      || null,
            meta.time      || null,
            meta.venue     || null,
            gigId,
          ]
        )
      } catch (err) {
        console.error('[Gigs] Meta save failed:', err)
      }
    }, 400)
    return () => clearTimeout(metaSaveRef.current)
  }, [meta.name, meta.band_name, meta.date, meta.time, meta.venue, gigId])

  // ── Derived: all song IDs currently in any set ────────────────────────
  // Used to enforce the no-duplicate rule and to mark used songs in the
  // left panel. Recomputed only when sets changes.
  const allUsedSongIds = useMemo(
    () => new Set(sets.flatMap(s => s.entries.map(e => e.songId))),
    [sets]
  )

  // ── Lock toggle ───────────────────────────────────────────────────────
  // Saves immediately (no debounce) — a single boolean write.
  async function toggleLock() {
    const next = !isLocked
    setIsLocked(next)
    try {
      await db.run('UPDATE gigs SET locked = ? WHERE id = ?', [next ? 1 : 0, gigId])
    } catch (err) {
      console.error('[Gigs] Lock save failed:', err)
      setIsLocked(isLocked)  // revert on error
    }
  }

  // ── DnD sensors ──────────────────────────────────────────────────────
  // activationConstraint.distance: require 8px of pointer movement before
  // drag activates. Prevents accidental drags when clicking buttons in rows.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  )

  // ── DnD event handlers ────────────────────────────────────────────────

  function handleDragStart({ active }) {
    setActiveDrag({
      type: active.data.current?.type,
      id:   active.id,
      data: active.data.current,
    })
  }

  function handleDragEnd({ active, over }) {
    setActiveDrag(null)
    if (!over) return
    // Safety guard: locked gigs must not be mutated even if drag somehow fires
    if (isLocked) return

    const type = active.data.current?.type

    // ── Drop a repertoire song onto a set ─────────────────────────────
    if (type === 'song') {
      const songId = active.data.current.song.id

      // No-duplicate rule: silently ignore if the song is already in the gig
      if (allUsedSongIds.has(songId)) return

      // Determine target set: over.id is either 'set-col-<id>' (empty column)
      // or an entryId from a sortable entry inside a column.
      let targetSetId
      if (typeof over.id === 'string' && over.id.startsWith('set-col-')) {
        targetSetId = over.id.slice('set-col-'.length)
      } else {
        // Dropped on top of an existing entry — find that entry's set
        targetSetId = findEntrySetId(sets, over.id)
      }
      if (!targetSetId) return

      setSets(prev => prev.map(set =>
        set.id === targetSetId
          ? { ...set, entries: [...set.entries, { entryId: newId(), songId }] }
          : set
      ))
    }

    // ── Reorder within a set or move to a different set ───────────────
    if (type === 'entry') {
      const fromSetId = findEntrySetId(sets, active.id)
      if (!fromSetId) return

      // Determine destination: column header or another entry
      let toSetId
      let toEntryId = null
      if (typeof over.id === 'string' && over.id.startsWith('set-col-')) {
        toSetId = over.id.slice('set-col-'.length)
      } else {
        toSetId   = findEntrySetId(sets, over.id)
        toEntryId = over.id
      }
      if (!toSetId) return

      if (fromSetId === toSetId) {
        // ── Same-set reorder via arrayMove ──────────────────────────
        setSets(prev => prev.map(set => {
          if (set.id !== fromSetId) return set
          const oldIdx = set.entries.findIndex(e => e.entryId === active.id)
          const newIdx = set.entries.findIndex(e => e.entryId === over.id)
          if (oldIdx < 0 || newIdx < 0 || oldIdx === newIdx) return set
          return { ...set, entries: arrayMove(set.entries, oldIdx, newIdx) }
        }))
      } else {
        // ── Cross-set move: remove from source, insert at destination ─
        setSets(prev => {
          // Find the entry object in the source set
          const entry = prev
            .find(s => s.id === fromSetId)
            ?.entries.find(e => e.entryId === active.id)
          if (!entry) return prev

          return prev.map(set => {
            if (set.id === fromSetId) {
              // Remove from source
              return { ...set, entries: set.entries.filter(e => e.entryId !== active.id) }
            }
            if (set.id === toSetId) {
              // Insert at position: before toEntryId if given, else at end
              const newEntries = [...set.entries]
              const insertAt = toEntryId
                ? newEntries.findIndex(e => e.entryId === toEntryId)
                : -1
              newEntries.splice(insertAt < 0 ? newEntries.length : insertAt, 0, entry)
              return { ...set, entries: newEntries }
            }
            return set
          })
        })
      }
    }
  }

  function handleDragCancel() {
    setActiveDrag(null)
  }

  // ── Set mutations ─────────────────────────────────────────────────────

  function addSet() {
    setSets(prev => [
      ...prev,
      { id: newId(), name: `Set ${prev.length + 1}`, entries: [] },
    ])
  }

  function renameSet(setId, newName) {
    setSets(prev => prev.map(s => s.id === setId ? { ...s, name: newName } : s))
  }

  function deleteSet(setId) {
    setSets(prev => prev.filter(s => s.id !== setId))
  }

  function removeEntryFromSet(setId, entryId) {
    setSets(prev => prev.map(set =>
      set.id === setId
        ? { ...set, entries: set.entries.filter(e => e.entryId !== entryId) }
        : set
    ))
  }

  // Adds a song to the first set (used by the "+" button in the left panel)
  function addSongToFirstSet(songId) {
    if (allUsedSongIds.has(songId)) return
    setSets(prev => {
      if (prev.length === 0) {
        // Create the first set on the fly if somehow missing
        return [{ id: newId(), name: 'Set 1', entries: [{ entryId: newId(), songId }] }]
      }
      return prev.map((set, i) =>
        i === 0
          ? { ...set, entries: [...set.entries, { entryId: newId(), songId }] }
          : set
      )
    })
  }

  // ── Delete gig ────────────────────────────────────────────────────────
  async function handleDelete() {
    try {
      await db.run('DELETE FROM gigs WHERE id = ?', [gigId])
      navigate('/gigs')
    } catch (err) {
      console.error('[Gigs] Delete failed:', err)
    }
  }

  // ── Part management ───────────────────────────────────────────────────
  // Toggles one part on/off and persists the change immediately.
  async function togglePart(part) {
    const next = parts.includes(part)
      ? parts.filter(p => p !== part)
      : [...parts, part]
    setParts(next)
    try {
      await db.run('UPDATE gigs SET parts = ? WHERE id = ?', [JSON.stringify(next), gigId])
    } catch (err) {
      console.error('[Gigs] Part save failed:', err)
      setParts(parts)  // revert on error
    }
  }

  // ── Export ────────────────────────────────────────────────────────────
  // Opens the progress modal and runs exportGig() from src/drive/export.js.
  async function startExport() {
    setExportOpen(true)
    setExportLog([])
    setExporting(true)
    setExportDone(false)
    setExportStage({ label: '', done: 0, total: 0 })

    // ── Pre-flight auth check ─────────────────────────────────────────────
    // If the token expires within 10 minutes, try a silent refresh before
    // starting — avoids a mid-export 401 failure.
    const msLeft = tokenExpiresIn()
    if (msLeft < 10 * 60 * 1000) {
      const isExpired = msLeft < 60_000
      setExportLog([isExpired
        ? '⚠ Session has expired — refreshing…'
        : `⚠ Session expires in ${Math.floor(msLeft / 60000)} min — refreshing…`,
      ])
      const refreshed = await refreshAccessToken()
      if (!refreshed) {
        setExportLog([`✗ Could not refresh session. Please sign out and sign back in, then try again.`])
        setExporting(false)
        setExportDone(true)
        return
      }
      setExportLog(prev => [...prev, '✓ Session refreshed — starting export'])
    }

    try {
      // Use a fresh gig row so exportGig sees the latest setlist + current parts
      const rows     = await db.exec('SELECT * FROM gigs WHERE id = ?', [gigId])
      const freshGig = rows[0] ?? gig
      await exportGig({
        gig:             { ...freshGig, parts: JSON.stringify(parts) },
        onProgress:      (msg) => setExportLog(prev => [...prev, msg]),
        onStageProgress: (label, done, total) => setExportStage({ label, done, total }),
      })
    } catch (err) {
      // Normalise: gapi errors reject with { result: { error: { message } } }
      // rather than a standard Error, so err.message may be undefined.
      const msg = err?.message
                || err?.result?.error?.message
                || (typeof err === 'string' ? err : JSON.stringify(err))
      setExportLog(prev => [...prev, `✗ Export failed: ${msg}`])
    }
    setExporting(false)
    setExportDone(true)
  }

  // ── Filtered left-panel songs ─────────────────────────────────────────
  const filteredSongs = useMemo(() => {
    if (!search) return songs
    const q = search.toLowerCase()
    return songs.filter(s =>
      s.title.toLowerCase().includes(q) || s.idx.includes(search)
    )
  }, [songs, search])

  // ── Drag overlay: find the song being dragged (for the floating preview) ──
  // For a repo drag: use the song object attached to active.data.
  // For an entry drag: look up the song via the sets + songMap.
  const draggedSong = useMemo(() => {
    if (!activeDrag) return null
    if (activeDrag.type === 'song') return activeDrag.data?.song ?? null
    if (activeDrag.type === 'entry') {
      const songId = sets
        .flatMap(s => s.entries)
        .find(e => e.entryId === activeDrag.id)
        ?.songId
      return songId ? (songMap.get(songId) ?? null) : null
    }
    return null
  }, [activeDrag, sets, songMap])

  // ── Render guards ─────────────────────────────────────────────────────
  if (notFound) {
    return (
      <div className={styles.listContainer}>
        <p className={styles.muted}>Gig not found.</p>
        <button className={styles.ghostBtn} onClick={() => navigate('/gigs')}>
          ← Back to Gigs
        </button>
      </div>
    )
  }
  if (!gig) return <p className={styles.muted}>Loading…</p>

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className={styles.editorWrap}>

      {/* ── Gig property header ──────────────────────────────────────── */}
      <div className={styles.editorHeader}>
        <div className={styles.headerRow1}>
          <button className={styles.backBtn} onClick={() => navigate('/gigs')}>
            ← Gigs
          </button>
          <input
            className={styles.gigNameInput}
            value={meta.name}
            onChange={e => setMeta(m => ({ ...m, name: e.target.value }))}
            placeholder="Gig name"
            readOnly={isLocked}
          />
          {/* Lock toggle — prominent when locked, subtle when unlocked */}
          <button
            className={`${styles.lockBtn} ${isLocked ? styles.lockBtnLocked : ''}`}
            onClick={toggleLock}
            title={isLocked ? 'Locked — click to unlock and edit' : 'Unlocked — click to lock'}
          >
            {isLocked ? '🔒 Locked' : '🔓 Unlocked'}
          </button>
          <span className={`${styles.saveStatus} ${saveStatus === 'saving' ? styles.saveStatusSaving : saveStatus === 'error' ? styles.saveStatusError : ''}`}>
            {saveStatus === 'saving' ? 'Saving…' : saveStatus === 'error' ? 'Save error' : 'Saved'}
          </span>
          <button className={styles.deleteBtn} onClick={() => setShowDelete(true)}>
            Delete gig
          </button>
        </div>
        <div className={styles.headerRow2}>
          <input
            className={styles.metaInput}
            value={meta.band_name}
            onChange={e => setMeta(m => ({ ...m, band_name: e.target.value }))}
            placeholder="Band name"
            readOnly={isLocked}
          />
          <input
            className={styles.metaInput}
            type="date"
            value={meta.date}
            onChange={e => setMeta(m => ({ ...m, date: e.target.value }))}
            readOnly={isLocked}
          />
          <input
            className={styles.metaInput}
            value={meta.time}
            onChange={e => setMeta(m => ({ ...m, time: e.target.value }))}
            placeholder="Time"
            readOnly={isLocked}
          />
          <input
            className={styles.metaInput}
            value={meta.venue}
            onChange={e => setMeta(m => ({ ...m, venue: e.target.value }))}
            placeholder="Venue"
            readOnly={isLocked}
          />
        </div>

        {/* ── Row 3: per-gig part checkboxes + Export button ───────────── */}
        <div className={styles.headerRow3}>
          <span className={styles.partsLabel}>Parts:</span>
          {activePartsDef.map(part => (
            <label
              key={part}
              className={`${styles.partChip} ${parts.includes(part) ? styles.partChipActive : ''}`}
            >
              <input
                type="checkbox"
                className={styles.partCheckbox}
                checked={parts.includes(part)}
                onChange={() => togglePart(part)}
              />
              {part}
            </label>
          ))}
          <button
            className={styles.exportBtn}
            onClick={startExport}
            disabled={parts.length === 0}
            title={parts.length === 0 ? 'Select at least one part to export' : 'Export gig to Google Drive'}
          >
            Export to Drive
          </button>
        </div>
      </div>

      {/* ── Export progress modal ────────────────────────────────────── */}
      {exportOpen && (
        <div
          className={styles.modalOverlay}
          onClick={exportDone ? () => setExportOpen(false) : undefined}
        >
          <div className={styles.modalPanel} onClick={e => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>
              {exporting ? 'Exporting…' : 'Export complete'}
            </h3>
            {/* Single resetting progress bar — label + pct change per stage */}
            {exportStage.total > 0 && (
              <div className={styles.exportProgressWrap}>
                <div className={styles.exportProgressHeader}>
                  <span className={styles.exportProgressLabel}>{exportStage.label}</span>
                  <span className={styles.exportProgressPct}>
                    {Math.round(exportStage.done / exportStage.total * 100)}%
                  </span>
                </div>
                <div className={styles.exportProgressTrack}>
                  <div
                    className={styles.exportProgressBar}
                    style={{ width: `${Math.round(exportStage.done / exportStage.total * 100)}%` }}
                  />
                </div>
              </div>
            )}
            <div className={styles.exportLog}>
              {exportLog.map((line, i) => {
                const cls = line.startsWith('✗') ? styles.exportLogError
                          : line.startsWith('⚠') ? styles.exportLogWarn
                          : line.startsWith('✓') ? styles.exportLogOk
                          : styles.exportLogLine
                return <div key={i} className={cls}>{line}</div>
              })}
              {exporting && <div className={styles.exportLogLine}>…</div>}
            </div>
            {exportDone && (
              <div className={styles.formActions}>
                <button className={styles.primaryBtn} onClick={() => setExportOpen(false)}>
                  Close
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Delete confirmation modal ─────────────────────────────────── */}
      {showDelete && (
        <div className={styles.modalOverlay} onClick={() => setShowDelete(false)}>
          <div className={styles.modalPanel} onClick={e => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>Delete "{meta.name}"?</h3>
            <p className={styles.muted}>This cannot be undone.</p>
            <div className={styles.formActions}>
              <button className={styles.ghostBtn} onClick={() => setShowDelete(false)}>
                Cancel
              </button>
              <button className={styles.dangerBtn} onClick={handleDelete}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Editor body: repertoire (left) + sets (right) ────────────── */}
      {/* DndContext must wrap BOTH the draggable sources (left panel) AND
          the droppable targets (right panel), plus the DragOverlay. */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <div className={styles.editorBody}>

          {/* ── Left panel: Repertoire ─────────────────────────────── */}
          <div className={`${styles.leftPanel} ${repoVisible ? '' : styles.leftPanelCollapsed}`}>
            <div className={styles.panelTitle}>
              {repoVisible && (
                <>
                  Repertoire
                  <span className={styles.panelCount}>{songs.length}</span>
                </>
              )}
              {/* Collapse / expand toggle — always visible */}
              <button
                className={styles.repoToggle}
                onClick={() => setRepoVisible(v => !v)}
                title={repoVisible ? 'Hide Repertoire' : 'Show Repertoire'}
              >
                {repoVisible ? '◀' : '▶'}
              </button>
            </div>
            {repoVisible && (
              <>
                <input
                  className={styles.searchInput}
                  type="text"
                  placeholder="Search title or index…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
                <div className={styles.repoList}>
                  {songs.length === 0 && (
                    <p className={styles.muted}>No songs — sync your library first.</p>
                  )}
                  {filteredSongs.length === 0 && songs.length > 0 && (
                    <p className={styles.muted}>No matches.</p>
                  )}
                  {filteredSongs.map(song => (
                    <DraggableSong
                      key={song.id}
                      song={song}
                      isUsed={allUsedSongIds.has(song.id)}
                      isLocked={isLocked}
                      onAdd={addSongToFirstSet}
                    />
                  ))}
                </div>
              </>
            )}
          </div>

          {/* ── Right area: set columns ────────────────────────────── */}
          <div className={styles.setsArea}>
            {sets.map(set => (
              <SetColumn
                key={set.id}
                set={set}
                songMap={songMap}
                isSongDragging={activeDrag?.type === 'song'}
                isLocked={isLocked}
                onRename={renameSet}
                onRemoveEntry={removeEntryFromSet}
                onDelete={deleteSet}
              />
            ))}
            {/* Add Set button hidden when locked */}
            {!isLocked && (
              <button className={styles.addSetBtn} onClick={addSet}>
                + Add Set
              </button>
            )}
          </div>
        </div>

        {/* ── Floating drag preview ─────────────────────────────────── */}
        {/* DragOverlay renders via a portal at document.body level so it
            floats above all other elements regardless of overflow:hidden. */}
        <DragOverlay>
          {draggedSong ? (
            <div className={styles.dragOverlay}>
              <IndexBadge
                idx={draggedSong.idx}
                songType={draggedSong.song_type}
                subtype={draggedSong.subtype}
              />
              <span className={styles.dragOverlayTitle}>{draggedSong.title}</span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  )
}

// ── Gigs (route entry point) ──────────────────────────────────────────────
// Routes to GigList when no gigId in URL, GigEditor otherwise.
// App.jsx defines the route as /gigs/:gigId? (gigId is optional).
export default function Gigs() {
  const { gigId } = useParams()
  return gigId ? <GigEditor gigId={gigId} /> : <GigList />
}
