// src/views/Settings.jsx

import { useEffect, useState } from 'react'
import { db } from '../db/index.js'
import { checkRootFolderExists, saveSettingsToDrive, saveGigsToDrive } from '../drive/sync-gigs.js'
import styles from './Settings.module.css'

export default function Settings() {
  const [settings, setSettings]               = useState(null)
  const [rootFolder, setRootFolder]           = useState('')
  const [rootFolderSaved, setRootFolderSaved] = useState('')
  const [rootSaveStatus, setRootSaveStatus]   = useState('')  // 'saved' | 'error' | 'notfound' | ''
  const [rootSaving, setRootSaving]           = useState(false)

  const [activeParts, setActiveParts] = useState([])   // current active_parts array
  const [newPartInput, setNewPartInput] = useState('')
  const [newPartError, setNewPartError] = useState(null)

  // ── Load all settings from DB ────────────────────────────────────────────
  useEffect(() => {
    db.exec('SELECT key, value FROM settings ORDER BY key')
      .then((rows) => {
        setSettings(rows)
        const rf = rows.find(r => r.key === 'root_drive_folder')
        if (rf) { const v = JSON.parse(rf.value); setRootFolder(v); setRootFolderSaved(v) }
        const ap = rows.find(r => r.key === 'active_parts')
        if (ap) setActiveParts(JSON.parse(ap.value))
      })
      .catch(console.error)
  }, [])

  // ── Root Drive folder ────────────────────────────────────────────────────

  async function handleSaveRootFolder() {
    const trimmed = rootFolder.trim()
    setRootSaving(true)
    setRootSaveStatus('')
    try {
      const exists = await checkRootFolderExists(trimmed)
      if (!exists) { setRootSaveStatus('notfound'); setRootSaving(false); return }
      await db.run(
        `INSERT OR REPLACE INTO settings (key, value) VALUES ('root_drive_folder', ?)`,
        [JSON.stringify(trimmed)]
      )
      setRootFolderSaved(trimmed)
      setRootSaveStatus('saved')
      setTimeout(() => setRootSaveStatus(''), 2000)
      saveSettingsToDrive()
      saveGigsToDrive()
    } catch (err) {
      console.error('[Settings] Save failed:', err)
      setRootSaveStatus('error')
    }
    setRootSaving(false)
  }

  // ── Active parts ─────────────────────────────────────────────────────────

  async function persistActiveParts(parts) {
    await db.run(
      `INSERT OR REPLACE INTO settings (key, value) VALUES ('active_parts', ?)`,
      [JSON.stringify(parts)]
    )
    saveSettingsToDrive()
  }

  async function handleAddPart() {
    const part = newPartInput.trim()
    if (!part) return
    if (activeParts.includes(part)) { setNewPartError(`"${part}" already exists`); return }
    setNewPartError(null)
    const next = [...activeParts, part]
    setActiveParts(next)
    setNewPartInput('')
    try { await persistActiveParts(next) }
    catch (err) { console.error('[Settings] Add part failed:', err); setActiveParts(activeParts) }
  }

  async function handleRemovePart(part) {
    const next = activeParts.filter(p => p !== part)
    setActiveParts(next)
    try { await persistActiveParts(next) }
    catch (err) { console.error('[Settings] Remove part failed:', err); setActiveParts(activeParts) }
  }

  // Keys in the editable sections — excluded from the raw diagnostic table
  const EDITABLE_KEYS = new Set(['root_drive_folder', 'active_parts'])

  return (
    <div className={styles.container}>
      <h2 className={styles.heading}>Settings</h2>

      {/* ── Drive section ──────────────────────────────────────────────── */}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Drive</h3>
        <label className={styles.fieldLabel}>
          Root Drive folder (top-level folder — use slashes for nested folders)
          <div className={styles.fieldRow}>
            <input
              className={styles.fieldInput}
              value={rootFolder}
              onChange={e => setRootFolder(e.target.value)}
              placeholder="e.g. The Vintage Ties 2021"
            />
            <button
              className={styles.saveBtn}
              onClick={handleSaveRootFolder}
              disabled={rootSaving || rootFolder.trim() === rootFolderSaved}
            >
              {rootSaving ? 'Checking…' : 'Save'}
            </button>
            {rootSaveStatus === 'saved'    && <span className={styles.savedMsg}>Saved</span>}
            {rootSaveStatus === 'error'    && <span className={styles.errorMsg}>Save error</span>}
            {rootSaveStatus === 'notfound' && <span className={styles.errorMsg}>Folder not found in Drive</span>}
          </div>
        </label>
        <p className={styles.hint}>
          Exports go to: <code>{rootFolder || '…'}/Setlists/&lt;gig name&gt;/&lt;part&gt;/</code><br />
          Sync files go to: <code>{rootFolder || '…'}/Fletcher Sync/</code>
        </p>
      </section>

      {/* ── Parts section ──────────────────────────────────────────────── */}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Parts</h3>
        <p className={styles.hint} style={{ marginTop: 0, marginBottom: 12 }}>
          All possible instrument parts — used as options for musicians and gig exports.
        </p>

        {/* Current parts as removable chips */}
        <div className={styles.partsList}>
          {activeParts.map(part => (
            <span key={part} className={styles.partItem}>
              {part}
              <button
                className={styles.partRemoveBtn}
                onClick={() => handleRemovePart(part)}
                title={`Remove "${part}"`}
              >
                ×
              </button>
            </span>
          ))}
          {activeParts.length === 0 && (
            <span className={styles.muted}>No parts defined.</span>
          )}
        </div>

        {/* Add new part */}
        <div className={styles.addPartRow}>
          <input
            className={styles.fieldInput}
            value={newPartInput}
            onChange={e => { setNewPartInput(e.target.value); setNewPartError(null) }}
            onKeyDown={e => { if (e.key === 'Enter') handleAddPart() }}
            placeholder="New part name…"
            style={{ width: 220 }}
          />
          <button
            className={styles.saveBtn}
            onClick={handleAddPart}
            disabled={!newPartInput.trim()}
          >
            Add
          </button>
          {newPartError && <span className={styles.errorMsg}>{newPartError}</span>}
        </div>
      </section>

      {/* ── Raw settings table (diagnostic) ────────────────────────────── */}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>All settings (read-only)</h3>
        {settings === null && <p className={styles.muted}>Loading…</p>}
        {settings && (
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.th}>Key</th>
                <th className={styles.th}>Value</th>
              </tr>
            </thead>
            <tbody>
              {settings
                .filter(s => !EDITABLE_KEYS.has(s.key))
                .map(s => (
                  <tr key={s.key}>
                    <td className={styles.tdKey}>{s.key}</td>
                    <td className={styles.tdVal}>
                      <pre className={styles.pre}>
                        {JSON.stringify(JSON.parse(s.value), null, 2)}
                      </pre>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
