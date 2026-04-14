// src/views/Setlist.jsx
// Step 3 will build this out fully.
// For now: lists the 5 seeded gigs from the DB.
import React, { useEffect, useState } from 'react'
import { db } from '../db/index.js'

export default function Setlist() {
  const [gigs, setGigs] = useState(null)

  useEffect(() => {
    db.exec('SELECT id, name, date FROM gigs ORDER BY date DESC')
      .then(setGigs)
      .catch(console.error)
  }, [])

  return (
    <div>
      <h2 style={styles.heading}>Setlists</h2>
      {gigs === null && <p style={styles.sub}>Loading…</p>}
      {gigs && gigs.length === 0 && <p style={styles.sub}>No gigs yet.</p>}
      {gigs && gigs.length > 0 && (
        <ul style={styles.list}>
          {gigs.map((g) => (
            <li key={g.id} style={styles.item}>
              <span style={styles.name}>{g.name}</span>
              <span style={styles.date}>{g.date ?? '—'}</span>
              <span style={styles.id}>{g.id}</span>
            </li>
          ))}
        </ul>
      )}
      <p style={styles.note}>Full setlist builder coming in Step 3.</p>
    </div>
  )
}

const styles = {
  heading: { color: '#1B2B4B', marginTop: 0 },
  sub: { color: '#4A5568', fontSize: 15 },
  list: { listStyle: 'none', padding: 0, margin: 0 },
  item: {
    display: 'flex',
    gap: 16,
    alignItems: 'center',
    padding: '10px 16px',
    borderRadius: 8,
    marginBottom: 6,
    background: '#fff',
    border: '1px solid #D0D9E8',
    fontSize: 14,
    fontFamily: 'Arial, sans-serif',
  },
  name: { fontWeight: 600, color: '#1B2B4B', flex: 1 },
  date: { color: '#4A5568', minWidth: 90 },
  id: { color: '#A0AEC0', fontSize: 12 },
  note: { color: '#A0AEC0', fontSize: 13, fontStyle: 'italic', marginTop: 24 },
}
