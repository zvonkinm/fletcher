// src/views/Settings.jsx
// Step 5 will build this out fully.
// For now: shows current settings values from the DB.
import React, { useEffect, useState } from 'react'
import { db } from '../db/index.js'

export default function Settings() {
  const [settings, setSettings] = useState(null)

  useEffect(() => {
    db.exec('SELECT key, value FROM settings ORDER BY key')
      .then(setSettings)
      .catch(console.error)
  }, [])

  return (
    <div>
      <h2 style={styles.heading}>Settings</h2>
      {settings === null && <p style={styles.sub}>Loading…</p>}
      {settings && (
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Key</th>
              <th style={styles.th}>Value</th>
            </tr>
          </thead>
          <tbody>
            {settings.map((s) => (
              <tr key={s.key}>
                <td style={styles.tdKey}>{s.key}</td>
                <td style={styles.tdVal}>
                  <pre style={styles.pre}>
                    {JSON.stringify(JSON.parse(s.value), null, 2)}
                  </pre>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p style={styles.note}>Full settings editor coming in Step 5.</p>
    </div>
  )
}

const styles = {
  heading: { color: '#1B2B4B', marginTop: 0 },
  sub: { color: '#4A5568', fontSize: 15 },
  table: { borderCollapse: 'collapse', fontSize: 13, fontFamily: 'Arial, sans-serif', width: '100%' },
  th: { textAlign: 'left', padding: '8px 12px', background: '#EFF2F7', color: '#1B2B4B', fontWeight: 600, borderBottom: '2px solid #D0D9E8' },
  tdKey: { padding: '8px 12px', fontWeight: 600, color: '#4A5568', verticalAlign: 'top', whiteSpace: 'nowrap', borderBottom: '1px solid #EFF2F7' },
  tdVal: { padding: '8px 12px', borderBottom: '1px solid #EFF2F7' },
  pre: { margin: 0, fontSize: 11, color: '#4A5568', whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
  note: { color: '#A0AEC0', fontSize: 13, fontStyle: 'italic', marginTop: 24 },
}
