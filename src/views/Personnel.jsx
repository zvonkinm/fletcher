// src/views/Personnel.jsx
// Personnel management — tracks musicians and their instruments.
//
// Each musician has: name, parts (subset of active_parts), locked.
// Changes are saved to SQLite immediately and synced to Drive fire-and-forget.

import { useEffect, useState, useCallback } from 'react'
import { db } from '../db/index.js'
import { saveMusiciansToDrive } from '../drive/sync-gigs.js'
import styles from './Personnel.module.css'

// Only these DB columns may be updated via handleUpdate — guards against
// unexpected keys reaching the dynamic SET clause.
const ALLOWED_COLS = new Set(['name', 'parts', 'locked', 'city', 'state'])

function newId() {
  return Math.random().toString(36).slice(2, 10)
}

// ── MusicianCard ─────────────────────────────────────────────────────────────
// Renders one musician row.
// When unlocked: name is an editable input, instruments are checkboxes.
// When locked: name and instruments are read-only.
function MusicianCard({ musician, activeParts, onUpdate, onDelete }) {
  // Local drafts — avoid re-renders while the user is mid-type.
  const [nameVal,  setNameVal]  = useState(musician.name)
  const [cityVal,  setCityVal]  = useState(musician.city  || '')
  const [stateVal, setStateVal] = useState(musician.state || '')

  // Keep drafts in sync if a Drive reload changes values externally.
  useEffect(() => { setNameVal(musician.name)         }, [musician.name])
  useEffect(() => { setCityVal(musician.city   || '') }, [musician.city])
  useEffect(() => { setStateVal(musician.state || '') }, [musician.state])

  const locked = musician.locked === 1
  const parts  = JSON.parse(musician.parts || '[]')

  function commitName() {
    const trimmed = nameVal.trim()
    if (!trimmed) { setNameVal(musician.name); return }
    if (trimmed !== musician.name) onUpdate(musician.id, { name: trimmed })
  }

  function commitCity() {
    const trimmed = cityVal.trim()
    if (trimmed !== (musician.city || '')) onUpdate(musician.id, { city: trimmed || null })
  }

  function commitState() {
    const trimmed = stateVal.trim()
    if (trimmed !== (musician.state || '')) onUpdate(musician.id, { state: trimmed || null })
  }

  function togglePart(part) {
    const next = parts.includes(part)
      ? parts.filter(p => p !== part)
      : [...parts, part]
    onUpdate(musician.id, { parts: JSON.stringify(next) })
  }

  function toggleLock() {
    onUpdate(musician.id, { locked: locked ? 0 : 1 })
  }

  return (
    <div className={`${styles.card} ${locked ? styles.cardLocked : ''}`}>

      {/* ── Main row: name · parts (inline) · actions ─────────────── */}
      <div className={styles.cardHeader}>
        {locked ? (
          <span className={styles.cardName}>{musician.name}</span>
        ) : (
          <input
            className={styles.cardNameInput}
            value={nameVal}
            onChange={e => setNameVal(e.target.value)}
            onBlur={commitName}
            onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
            placeholder="Musician name"
          />
        )}

        {/* Parts sit inline between the name and the action buttons */}
        <div className={styles.partsRow}>
          {locked ? (
            // Read-only chips — only the parts the musician actually plays
            parts.length > 0
              ? parts.map(p => <span key={p} className={styles.partChip}>{p}</span>)
              : <span className={styles.noPartsLabel}>No instruments</span>
          ) : (
            // Editable checkbox chips — one per active_part
            activeParts.map(part => (
              <label
                key={part}
                className={`${styles.partChipCheck} ${parts.includes(part) ? styles.partChipCheckActive : ''}`}
              >
                <input
                  type="checkbox"
                  className={styles.partCheckbox}
                  checked={parts.includes(part)}
                  onChange={() => togglePart(part)}
                />
                {part}
              </label>
            ))
          )}
        </div>

        <div className={styles.cardActions}>
          <button
            className={`${styles.lockBtn} ${locked ? styles.lockBtnLocked : ''}`}
            onClick={toggleLock}
            title={locked ? 'Locked — click to unlock' : 'Unlocked — click to lock'}
          >
            {locked ? '🔒 Locked' : '🔓 Unlocked'}
          </button>
          {!locked && (
            <button
              className={styles.removeBtn}
              onClick={() => onDelete(musician.id)}
              title="Remove musician"
            >
              ×
            </button>
          )}
        </div>
      </div>

      {/* ── Location row: city + state ─────────────────────────────── */}
      {locked ? (
        (musician.city || musician.state) && (
          <div className={styles.locationRow}>
            <span className={styles.locationLabel}>
              {[musician.city, musician.state].filter(Boolean).join(', ')}
            </span>
          </div>
        )
      ) : (
        <div className={styles.locationRow}>
          <input
            className={styles.locationInput}
            value={cityVal}
            onChange={e => setCityVal(e.target.value)}
            onBlur={commitCity}
            onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
            placeholder="City"
          />
          <input
            className={styles.locationInput}
            value={stateVal}
            onChange={e => setStateVal(e.target.value)}
            onBlur={commitState}
            onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
            placeholder="State"
          />
        </div>
      )}
    </div>
  )
}

// ── AddMusicianModal ─────────────────────────────────────────────────────────
function AddMusicianModal({ activeParts, onSave, onCancel }) {
  const [name,     setName]     = useState('')
  const [parts,    setParts]    = useState([])
  const [locCity,  setLocCity]  = useState('')
  const [locState, setLocState] = useState('')
  const [saving,   setSaving]   = useState(false)
  const [error,    setError]    = useState(null)

  function togglePart(part) {
    setParts(prev =>
      prev.includes(part) ? prev.filter(p => p !== part) : [...prev, part]
    )
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!name.trim()) { setError('Name is required.'); return }
    setSaving(true); setError(null)
    try {
      await db.run(
        `INSERT INTO musicians (id, name, parts, city, state, locked) VALUES (?, ?, ?, ?, ?, 1)`,
        [newId(), name.trim(), JSON.stringify(parts), locCity.trim() || null, locState.trim() || null]
      )
      saveMusiciansToDrive()
      onSave()
    } catch (err) {
      console.error('[Personnel] Add failed:', err)
      setError(err.message)
      setSaving(false)
    }
  }

  return (
    <div className={styles.modalOverlay} onClick={e => { if (e.target === e.currentTarget) onCancel() }}>
      <div className={styles.modalPanel}>
        <h3 className={styles.modalTitle}>Add Musician</h3>
        <form onSubmit={handleSubmit} className={styles.form}>

          <label className={styles.formLabel}>
            Name *
            <input
              className={styles.formInput}
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. John Smith"
              autoFocus
            />
          </label>

          <div className={styles.formLabel}>
            Instruments
            <div className={styles.partsGrid}>
              {activeParts.map(part => (
                <label
                  key={part}
                  className={`${styles.partChipCheck} ${parts.includes(part) ? styles.partChipCheckActive : ''}`}
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
            </div>
          </div>

          {/* City + State on one row */}
          <div className={styles.formRow}>
            <label className={styles.formLabel} style={{ flex: 1 }}>
              City
              <input
                className={styles.formInput}
                value={locCity}
                onChange={e => setLocCity(e.target.value)}
                placeholder="e.g. Austin"
              />
            </label>
            <label className={styles.formLabel} style={{ flex: '0 0 90px' }}>
              State
              <input
                className={styles.formInput}
                value={locState}
                onChange={e => setLocState(e.target.value)}
                placeholder="e.g. TX"
              />
            </label>
          </div>

          {error && <p className={styles.formError}>{error}</p>}

          <div className={styles.formActions}>
            <button type="button" className={styles.ghostBtn} onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className={styles.primaryBtn} disabled={saving}>
              {saving ? 'Adding…' : 'Add Musician'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Personnel (route entry point) ─────────────────────────────────────────────
export default function Personnel() {
  const [musicians, setMusicians] = useState(null)
  const [activeParts, setActiveParts] = useState([])
  const [filter, setFilter]       = useState(null)   // null = All, or part name
  const [showAdd, setShowAdd]     = useState(false)

  const loadMusicians = useCallback(async () => {
    try {
      const rows = await db.exec(
        'SELECT id, name, parts, city, state, locked FROM musicians ORDER BY name ASC'
      )
      setMusicians(rows)
    } catch (err) {
      console.error('[Personnel] Load failed:', err)
    }
  }, [])

  useEffect(() => {
    loadMusicians()
    db.exec(`SELECT value FROM settings WHERE key = 'active_parts'`)
      .then(rows => { if (rows.length > 0) setActiveParts(JSON.parse(rows[0].value)) })
      .catch(console.error)
  }, [loadMusicians])

  // ── Mutations ─────────────────────────────────────────────────────────

  async function handleUpdate(id, changes) {
    const keys = Object.keys(changes)
    if (keys.some(k => !ALLOWED_COLS.has(k))) {
      console.error('[Personnel] Rejected update with disallowed column:', changes)
      return
    }
    try {
      const setClauses = keys.map(k => `${k} = ?`).join(', ')
      await db.run(
        `UPDATE musicians SET ${setClauses} WHERE id = ?`,
        [...Object.values(changes), id]
      )
      setMusicians(prev => prev.map(m => m.id === id ? { ...m, ...changes } : m))
      saveMusiciansToDrive()
    } catch (err) {
      console.error('[Personnel] Update failed:', err)
    }
  }

  async function handleDelete(id) {
    try {
      await db.run('DELETE FROM musicians WHERE id = ?', [id])
      setMusicians(prev => prev.filter(m => m.id !== id))
      saveMusiciansToDrive()
    } catch (err) {
      console.error('[Personnel] Delete failed:', err)
    }
  }

  // ── Derived list ──────────────────────────────────────────────────────

  const filtered = musicians?.filter(m =>
    !filter || JSON.parse(m.parts || '[]').includes(filter)
  ) ?? []

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div className={styles.container}>

      {/* ── Header ────────────────────────────────────────────────── */}
      <div className={styles.header}>
        <h2 className={styles.heading}>Personnel</h2>
        <button className={styles.primaryBtn} onClick={() => setShowAdd(true)}>
          + Add Musician
        </button>
      </div>

      {/* ── Filter chips ──────────────────────────────────────────── */}
      {activeParts.length > 0 && (
        <div className={styles.filterRow}>
          <button
            className={`${styles.chip} ${!filter ? styles.chipActive : ''}`}
            onClick={() => setFilter(null)}
          >
            All
          </button>
          {activeParts.map(part => (
            <button
              key={part}
              className={`${styles.chip} ${filter === part ? styles.chipActive : ''}`}
              onClick={() => setFilter(f => f === part ? null : part)}
            >
              {part}
            </button>
          ))}
        </div>
      )}

      {/* ── Add musician modal ─────────────────────────────────────── */}
      {showAdd && (
        <AddMusicianModal
          activeParts={activeParts}
          onSave={() => { setShowAdd(false); loadMusicians() }}
          onCancel={() => setShowAdd(false)}
        />
      )}

      {/* ── States ────────────────────────────────────────────────── */}
      {musicians === null && (
        <p className={styles.muted}>Loading…</p>
      )}
      {musicians?.length === 0 && !showAdd && (
        <p className={styles.muted}>No musicians yet — click "+ Add Musician" to add one.</p>
      )}
      {musicians?.length > 0 && filtered.length === 0 && (
        <p className={styles.muted}>No musicians play {filter}.</p>
      )}

      {/* ── Musician list ──────────────────────────────────────────── */}
      <div className={styles.musicianList}>
        {filtered.map(musician => (
          <MusicianCard
            key={musician.id}
            musician={musician}
            activeParts={activeParts}
            onUpdate={handleUpdate}
            onDelete={handleDelete}
          />
        ))}
      </div>
    </div>
  )
}
