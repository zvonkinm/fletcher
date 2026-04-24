// src/views/Stats.jsx
// Aggregated statistics computed from all gig + musician records in SQLite.
//
// Sections:
//   1. Summary row   — quick count cards (gigs, unique songs, musicians, venues)
//   2. Song frequency — how often each song is programmed; main vs. backup sets
//   3. Musician frequency — gig count per musician with mini bar chart
//   4. Venues        — gig count per venue
//   5. Bands         — gig count per band name (only shown when >1 distinct name)
//
// A "backup" set is one whose name matches /backup|alt|alternate|extra/i.
// Write-in entries (songId starting with "wi:") are excluded from song stats.
// The year filter rewrites all five sections in-place.

import { useEffect, useState, useMemo } from 'react'
import { db } from '../db/index.js'
import styles from './Stats.module.css'

// ── Type colour map (matches Repertoire + Gigs) ─────────────────────────────
const TYPE_COLORS = {
  'Arrangements/Swing':   { bg: '#1A6B3C', text: '#fff' },
  'Arrangements/12 Bar':  { bg: '#1a56a0', text: '#fff' },
  'Arrangements/Bluesy':  { bg: '#5b8dd9', text: '#fff' },
  'Instrumentals/Swing':  { bg: '#ca8a04', text: '#fff' },
  'Instrumentals/12 Bar': { bg: '#e06b10', text: '#fff' },
  'Lead Sheet/Swing':     { bg: '#C0392B', text: '#fff' },
  'Lead Sheet/12 Bar':    { bg: '#7c3aed', text: '#fff' },
  'Lead Sheet/Bluesy':    { bg: '#c06090', text: '#fff' },
  'Unknown/Unknown':      { bg: '#718096', text: '#fff' },
}

// ── Setlist parser ────────────────────────────────────────────────────────────
// Returns [{ name, songIds }] from stored setlist JSON.
// Handles legacy flat string[] and current {id, name, song_ids}[] formats.
function parseSets(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return []
  if (typeof raw[0] === 'string') return [{ name: 'Set 1', songIds: raw }]
  return raw.map(s => ({ name: s.name || 'Set', songIds: s.song_ids || [] }))
}

function isBackupSet(name) {
  return /backup|alt|alternate|extra/i.test(name)
}

// ── Sortable column header ───────────────────────────────────────────────────
function SortTh({ col, label, current, onSort, right }) {
  const active = current === col
  return (
    <th
      className={[styles.th, styles.thSortable, active ? styles.thActive : '', right ? styles.thRight : ''].filter(Boolean).join(' ')}
      onClick={() => onSort(col)}
      title={`Sort by ${label}`}
    >
      {label}{active ? ' ↓' : ''}
    </th>
  )
}

// ── Mini percentage bar ──────────────────────────────────────────────────────
function PctBar({ pct }) {
  return (
    <span className={styles.pctCell}>
      <span className={styles.pctTrack}>
        <span className={styles.pctFill} style={{ width: `${Math.min(pct, 100)}%` }} />
      </span>
      <span className={styles.pctNum}>{pct}%</span>
    </span>
  )
}

// ── Main component ───────────────────────────────────────────────────────────
export default function Stats() {
  const [gigs,      setGigs]      = useState(null)
  const [songs,     setSongs]     = useState(null)
  const [musicians, setMusicians] = useState(null)

  const [yearFilter, setYearFilter] = useState('all')
  const [songSort,   setSongSort]   = useState('total')   // 'total'|'main'|'backup'|'idx'|'title'

  // ── Load all raw data once ───────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      const [gigRows, songRows, musRows] = await Promise.all([
        db.exec(
          `SELECT id, name, band_name, date, venue, city, state, setlist, lineup
           FROM gigs ORDER BY date DESC, name ASC`
        ),
        db.exec(
          `SELECT id, idx, key_variant, title, song_type, subtype
           FROM songs WHERE active = 1`
        ),
        db.exec(
          `SELECT id, name, parts FROM musicians ORDER BY name ASC`
        ),
      ])
      setGigs(gigRows)
      setSongs(songRows)
      setMusicians(musRows)
    }
    load().catch(console.error)
  }, [])

  // ── Available years for the filter ──────────────────────────────────────
  const years = useMemo(() => {
    if (!gigs) return []
    const ys = new Set()
    for (const g of gigs) if (g.date) ys.add(g.date.slice(0, 4))
    return [...ys].sort().reverse()
  }, [gigs])

  // ── Filtered gigs ────────────────────────────────────────────────────────
  const filteredGigs = useMemo(() => {
    if (!gigs) return []
    if (yearFilter === 'all') return gigs
    return gigs.filter(g => g.date?.startsWith(yearFilter))
  }, [gigs, yearFilter])

  // ── Song map: id → song row ──────────────────────────────────────────────
  const songMap = useMemo(() => {
    if (!songs) return new Map()
    return new Map(songs.map(s => [s.id, s]))
  }, [songs])

  // ── Section 1: song frequency ────────────────────────────────────────────
  // Counts per gig (not per appearance) so a song in two sets of the same gig
  // still counts as 1.  Main / backup split is set-level.
  const songStats = useMemo(() => {
    if (!filteredGigs.length || !songMap.size) return []

    // songId → { main, backup }
    const counts = new Map()

    for (const gig of filteredGigs) {
      let sets
      try { sets = parseSets(JSON.parse(gig.setlist || '[]')) } catch { sets = [] }

      // Track which (songId, isBackup) pairs we've already counted for this gig
      // to prevent double-counting a song that appears in two sets of the same type.
      const seenMain   = new Set()
      const seenBackup = new Set()

      for (const set of sets) {
        const backup = isBackupSet(set.name)
        const seen   = backup ? seenBackup : seenMain

        for (const songId of set.songIds) {
          if (songId.startsWith('wi:')) continue  // skip write-ins
          if (seen.has(songId)) continue
          seen.add(songId)

          if (!counts.has(songId)) counts.set(songId, { main: 0, backup: 0 })
          const c = counts.get(songId)
          if (backup) { c.backup++ } else { c.main++ }
        }
      }
    }

    return [...counts.entries()]
      .map(([id, c]) => {
        const s = songMap.get(id)
        return {
          id,
          idx:        s?.idx         ?? id,
          keyVariant: s?.key_variant ?? null,
          title:      s?.title       ?? id,
          typeKey:    `${s?.song_type ?? 'Unknown'}/${s?.subtype ?? 'Unknown'}`,
          main:       c.main,
          backup:     c.backup,
          total:      c.main + c.backup,
        }
      })
      .sort((a, b) => {
        const dir = { total: 'desc', main: 'desc', backup: 'desc', idx: 'asc', title: 'asc' }[songSort] ?? 'desc'
        let cmp = 0
        if (songSort === 'total')  cmp = b.total  - a.total
        if (songSort === 'main')   cmp = b.main   - a.main
        if (songSort === 'backup') cmp = b.backup - a.backup
        if (songSort === 'idx')    cmp = a.idx.localeCompare(b.idx)
        if (songSort === 'title')  cmp = a.title.localeCompare(b.title)
        // Secondary: idx ascending for count columns, title for idx/title sorts
        if (cmp === 0) cmp = (dir === 'desc') ? a.idx.localeCompare(b.idx) : 0
        return cmp
      })
  }, [filteredGigs, songMap, songSort])

  // ── Section 2: musician frequency ────────────────────────────────────────
  const musicianStats = useMemo(() => {
    if (!filteredGigs.length || !musicians?.length) return []

    const counts = new Map()  // musicianId → gig count

    for (const gig of filteredGigs) {
      try {
        if (!gig.lineup) continue
        const lineup = JSON.parse(gig.lineup)
        const assignedIds = new Set(
          Object.values(lineup).map(pl => pl.assigned).filter(Boolean)
        )
        for (const id of assignedIds) counts.set(id, (counts.get(id) ?? 0) + 1)
      } catch {}
    }

    const total = filteredGigs.length

    return musicians
      .filter(m => counts.has(m.id))
      .map(m => {
        const count = counts.get(m.id)
        return {
          id:    m.id,
          name:  m.name,
          parts: (() => { try { return JSON.parse(m.parts || '[]').join(', ') } catch { return '' } })(),
          count,
          pct:   Math.round(count / total * 100),
        }
      })
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  }, [filteredGigs, musicians])

  // ── Section 3: venue frequency ────────────────────────────────────────────
  const venueStats = useMemo(() => {
    const map = new Map()
    for (const gig of filteredGigs) {
      if (!gig.venue) continue
      if (!map.has(gig.venue)) {
        map.set(gig.venue, { venue: gig.venue, city: gig.city, state: gig.state, count: 0 })
      }
      map.get(gig.venue).count++
    }
    return [...map.values()].sort((a, b) => b.count - a.count || a.venue.localeCompare(b.venue))
  }, [filteredGigs])

  // ── Section 4: band frequency ─────────────────────────────────────────────
  // Only shown when there are two or more distinct non-empty band names.
  const bandStats = useMemo(() => {
    const map = new Map()
    for (const gig of filteredGigs) {
      const key = (gig.band_name || '').trim()
      if (!key) continue
      map.set(key, (map.get(key) ?? 0) + 1)
    }
    if (map.size < 2) return []
    return [...map.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  }, [filteredGigs])

  // ── Render ────────────────────────────────────────────────────────────────
  if (!gigs || !songs || !musicians) {
    return <p className={styles.muted}>Loading…</p>
  }

  return (
    <div className={styles.container}>

      {/* ── Page header + year filter ────────────────────────────────── */}
      <div className={styles.pageHeader}>
        <h2 className={styles.heading}>Stats</h2>
        <label className={styles.filterLabel}>
          <select
            className={styles.filterSelect}
            value={yearFilter}
            onChange={e => setYearFilter(e.target.value)}
          >
            <option value="all">All years</option>
            {years.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </label>
      </div>

      {/* ── Summary cards ────────────────────────────────────────────── */}
      <div className={styles.summaryRow}>
        {[
          { num: filteredGigs.length,   label: 'Gigs'              },
          { num: songStats.length,       label: 'Songs programmed'  },
          { num: musicianStats.length,   label: 'Musicians hired'   },
          { num: venueStats.length,      label: 'Venues'            },
        ].map(({ num, label }) => (
          <div key={label} className={styles.summaryCard}>
            <span className={styles.summaryNum}>{num}</span>
            <span className={styles.summaryLabel}>{label}</span>
          </div>
        ))}
      </div>

      {/* ── Song frequency ───────────────────────────────────────────── */}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Song frequency</h3>
        <p className={styles.sectionHint}>
          Counted once per gig even if a song appears in multiple sets.
          "Backup" = sets whose name matches backup / alt / alternate / extra.
        </p>
        {songStats.length === 0 ? (
          <p className={styles.muted}>No setlist data.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <SortTh col="idx"    label="#"      current={songSort} onSort={setSongSort} />
                  <SortTh col="title"  label="Title"  current={songSort} onSort={setSongSort} />
                  <th className={styles.th}>Type</th>
                  <SortTh col="main"   label="Main"   current={songSort} onSort={setSongSort} right />
                  <SortTh col="backup" label="Backup" current={songSort} onSort={setSongSort} right />
                  <SortTh col="total"  label="Total"  current={songSort} onSort={setSongSort} right />
                </tr>
              </thead>
              <tbody>
                {songStats.map(s => {
                  const colors = TYPE_COLORS[s.typeKey] ?? TYPE_COLORS['Unknown/Unknown']
                  return (
                    <tr key={s.id} className={styles.tr}>
                      <td className={styles.tdIdx}>
                        <span className={styles.idxBadge} style={{ background: colors.bg, color: colors.text }}>
                          {s.idx}{s.keyVariant ? `#${s.keyVariant}` : ''}
                        </span>
                      </td>
                      <td className={styles.tdTitle}>{s.title}</td>
                      <td className={styles.tdType}>{s.typeKey}</td>
                      <td className={styles.tdNum}>{s.main   || '—'}</td>
                      <td className={styles.tdNum}>{s.backup || '—'}</td>
                      <td className={`${styles.tdNum} ${styles.tdBold}`}>{s.total}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Musician frequency ───────────────────────────────────────── */}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Musician frequency</h3>
        {musicianStats.length === 0 ? (
          <p className={styles.muted}>No lineup data.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.th}>Name</th>
                  <th className={styles.th}>Parts</th>
                  <th className={`${styles.th} ${styles.thRight}`}>Gigs</th>
                  <th className={`${styles.th} ${styles.thRight}`}>% of gigs</th>
                </tr>
              </thead>
              <tbody>
                {musicianStats.map(m => (
                  <tr key={m.id} className={styles.tr}>
                    <td className={styles.tdTitle}>{m.name}</td>
                    <td className={styles.tdMuted}>{m.parts || '—'}</td>
                    <td className={`${styles.tdNum} ${styles.tdBold}`}>{m.count}</td>
                    <td className={styles.tdNum}><PctBar pct={m.pct} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Venues ───────────────────────────────────────────────────── */}
      {venueStats.length > 0 && (
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>Venues</h3>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.th}>Venue</th>
                  <th className={styles.th}>Location</th>
                  <th className={`${styles.th} ${styles.thRight}`}>Gigs</th>
                </tr>
              </thead>
              <tbody>
                {venueStats.map(v => (
                  <tr key={v.venue} className={styles.tr}>
                    <td className={styles.tdTitle}>{v.venue}</td>
                    <td className={styles.tdMuted}>
                      {[v.city, v.state].filter(Boolean).join(', ') || '—'}
                    </td>
                    <td className={`${styles.tdNum} ${styles.tdBold}`}>{v.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── Bands (only when multiple distinct names exist) ───────────── */}
      {bandStats.length > 0 && (
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>Bands</h3>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.th}>Band</th>
                  <th className={`${styles.th} ${styles.thRight}`}>Gigs</th>
                </tr>
              </thead>
              <tbody>
                {bandStats.map(b => (
                  <tr key={b.name} className={styles.tr}>
                    <td className={styles.tdTitle}>{b.name}</td>
                    <td className={`${styles.tdNum} ${styles.tdBold}`}>{b.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

    </div>
  )
}
