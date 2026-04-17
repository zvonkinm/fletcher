// src/views/Settings.jsx
// Minimal settings page — Step 5 will build this out fully.
// Currently exposes one editable field (export_folder_name) and shows
// the remaining settings as a read-only diagnostic table.

import React, { useEffect, useState } from 'react'
import { db } from '../db/index.js'
import styles from './Settings.module.css'

export default function Settings() {
  const [settings, setSettings]             = useState(null)   // all rows
  const [exportFolder, setExportFolder]     = useState('')     // editable field value
  const [exportFolderSaved, setExportFolderSaved] = useState('')  // last-saved value
  const [saveStatus, setSaveStatus]         = useState('')     // 'saved' | 'error' | ''

  // ── Load settings from DB ──────────────────────────────────────────────
  useEffect(() => {
    db.exec('SELECT key, value FROM settings ORDER BY key')
      .then((rows) => {
        setSettings(rows)
        const ef = rows.find(r => r.key === 'export_folder_name')
        if (ef) {
          const val = JSON.parse(ef.value)
          setExportFolder(val)
          setExportFolderSaved(val)
        }
      })
      .catch(console.error)
  }, [])

  // ── Save export_folder_name ────────────────────────────────────────────
  async function handleSaveExportFolder() {
    try {
      await db.run(
        `INSERT OR REPLACE INTO settings (key, value) VALUES ('export_folder_name', ?)`,
        [JSON.stringify(exportFolder.trim())]
      )
      setExportFolderSaved(exportFolder.trim())
      setSaveStatus('saved')
      setTimeout(() => setSaveStatus(''), 2000)
    } catch (err) {
      console.error('[Settings] Save failed:', err)
      setSaveStatus('error')
    }
  }

  // Keys shown in the editable section — excluded from the raw table below
  const EDITABLE_KEYS = new Set(['export_folder_name'])

  return (
    <div className={styles.container}>
      <h2 className={styles.heading}>Settings</h2>

      {/* ── Editable section ── */}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Export</h3>
        <label className={styles.fieldLabel}>
          Export folder (Drive path prefix — use slashes for nested folders)
          <div className={styles.fieldRow}>
            <input
              className={styles.fieldInput}
              value={exportFolder}
              onChange={e => setExportFolder(e.target.value)}
              placeholder="e.g. The Vintage Ties 2021"
            />
            <button
              className={styles.saveBtn}
              onClick={handleSaveExportFolder}
              disabled={exportFolder.trim() === exportFolderSaved}
            >
              Save
            </button>
            {saveStatus === 'saved' && <span className={styles.savedMsg}>Saved</span>}
            {saveStatus === 'error' && <span className={styles.errorMsg}>Error</span>}
          </div>
        </label>
        <p className={styles.hint}>
          Exports go to: <code>{exportFolder || '…'}/Setlists/&lt;gig name&gt;/&lt;part&gt;/</code>
        </p>
      </section>

      {/* ── Raw settings table (diagnostic) ── */}
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

      <p className={styles.muted}>Full settings editor coming in Step 5.</p>
    </div>
  )
}
