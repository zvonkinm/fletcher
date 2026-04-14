// src/views/Repertoire.jsx
// Step 2 will build this out fully.
// For now: confirms DB is working by counting songs.
import React, { useEffect, useState } from 'react'
import { db } from '../db/index.js'

export default function Repertoire() {
  const [count, setCount] = useState(null)

  useEffect(() => {
    db.exec('SELECT COUNT(*) AS n FROM songs')
      .then((rows) => setCount(rows[0].n))
      .catch(console.error)
  }, [])

  return (
    <div>
      <h2 style={styles.heading}>Repertoire</h2>
      <p style={styles.sub}>
        {count === null
          ? 'Loading…'
          : count === 0
          ? 'No songs yet — use Sync Library to import from Google Drive.'
          : `${count} song${count === 1 ? '' : 's'} in library.`}
      </p>
      <p style={styles.note}>Full song library view coming in Step 2.</p>
    </div>
  )
}

const styles = {
  heading: { color: '#1B2B4B', marginTop: 0 },
  sub: { color: '#4A5568', fontSize: 15 },
  note: { color: '#A0AEC0', fontSize: 13, fontStyle: 'italic' },
}
