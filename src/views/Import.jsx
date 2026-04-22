// src/views/Import.jsx
// One-time import of historical gig data from spreadsheet CSV exports.
//
// Section 1 — Booking Info CSV: imports gigs with venue, date, band name,
//   time, lineup (musician assignments), and financials.
//   Expected columns (any order, matched by header name):
//     Date, Venue, Band name, Time, Contract Pay,
//     Rhythm guitar, Bass, Drums, Lead guitar, Tenor Sax, Clarinet, Vocalist,
//     Venue pay, Cash tips, Venmo, Out of pocket, Paid per person
//
// Section 2 — Setlist CSV: placeholder; will populate setlists on already-
//   imported gigs once the sheet format is provided.
//
// All imported gigs are created as locked=1 (historical/read-only by default).
// Setlists are left empty []; musicians not already in the DB are auto-created.

import { useState } from 'react'
import { db } from '../db/index.js'
import { saveGigsToDrive, saveMusiciansToDrive } from '../drive/sync-gigs.js'
import styles from './Import.module.css'

// ── CSV parser ────────────────────────────────────────────────────────────────
// Handles quoted fields (commas inside quotes, doubled-quote escapes).

function parseCsv(text) {
  const rows = []
  let i = 0
  const n = text.length

  while (i < n) {
    const row = []
    // Parse one row of fields
    while (i < n && text[i] !== '\n' && text[i] !== '\r') {
      if (text[i] === '"') {
        // Quoted field
        i++ // skip opening quote
        let field = ''
        while (i < n) {
          if (text[i] === '"') {
            if (text[i + 1] === '"') { field += '"'; i += 2 }
            else                     { i++; break }          // closing quote
          } else {
            field += text[i++]
          }
        }
        row.push(field)
        if (text[i] === ',') i++
      } else {
        // Unquoted field — read until comma or newline
        let j = i
        while (j < n && text[j] !== ',' && text[j] !== '\n' && text[j] !== '\r') j++
        row.push(text.slice(i, j))
        i = j
        if (text[i] === ',') i++
      }
    }
    // Skip line ending(s)
    while (i < n && (text[i] === '\n' || text[i] === '\r')) i++
    if (row.length > 0) rows.push(row)
  }
  return rows
}

// ── Lineup columns: CSV header → app part name ────────────────────────────────

const LINEUP_COLS = [
  { csvCol: 'Rhythm guitar', appPart: 'Rhythm Guitar'    },
  { csvCol: 'Bass',          appPart: 'Bass'             },
  { csvCol: 'Drums',         appPart: 'Drums'            },
  { csvCol: 'Lead guitar',   appPart: 'Electric Guitar'  },
  { csvCol: 'Tenor Sax',     appPart: 'Tenor Saxophone'  },
  { csvCol: 'Clarinet',      appPart: 'Clarinet'         },
  { csvCol: 'Vocalist',      appPart: 'Vocals'           },
]

// ── Field parsers ─────────────────────────────────────────────────────────────

// "8/28/2021" → "2021-08-28"
function parseDate(s) {
  if (!s) return null
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (!m) return null
  const [, mo, da, yr] = m
  return `${yr}-${mo.padStart(2, '0')}-${da.padStart(2, '0')}`
}

// "7:30 - 10:00" → { start: "7:30", end: "10:00" }
// "1:00 - 3:00" → { start: "1:00", end: "3:00" }
function parseTime(s) {
  if (!s || !s.trim()) return { start: null, end: null }
  const m = s.trim().match(/^([\d:]+\s*(?:am|pm)?)\s*[-–]\s*([\d:]+\s*(?:am|pm)?)$/i)
  if (!m) return { start: s.trim() || null, end: null }
  return { start: m[1].trim() || null, end: m[2].trim() || null }
}

// "$1,575.00" | "-$20.00" | "N/A" | "" → number | null
// Returns null for empty/N/A, 0 for "$0.00", negative for "-$20.00"
function parseDollar(s) {
  if (!s || !s.trim() || /^n\/a$/i.test(s.trim())) return null
  const cleaned = s.replace(/[$, ]/g, '').trim()
  if (!cleaned) return null
  const n = parseFloat(cleaned)
  return isNaN(n) ? null : n
}

// "$225/pp" → { value: 225, mode: 'per_person' }
// "$600+$60"→ { value: 660, mode: 'total' }
// "30% of sales" → { value: null, mode: 'total' }
function parseContractPay(s) {
  if (!s || !s.trim()) return { value: null, mode: 'total' }
  const isPerPerson = /\/pp/i.test(s)
  // Sum all dollar amounts in the string (handles "$600+$60")
  const amounts = [...s.matchAll(/\$?([\d,]+(?:\.\d+)?)/g)]
    .map(m => parseFloat(m[1].replace(/,/g, '')))
    .filter(n => !isNaN(n))
  const value = amounts.length ? amounts.reduce((a, b) => a + b, 0) : null
  return { value, mode: isPerPerson ? 'per_person' : 'total' }
}

// "The Highball" → "the_highball"
function slugify(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    || 'gig'
}

// Generate a unique gig ID; appends _2, _3, … if base already taken.
function makeGigId(venue, dateStr, usedIds) {
  const base = `${slugify(venue)}_${dateStr.replace(/-/g, '')}`
  if (!usedIds.has(base)) return base
  let i = 2
  while (usedIds.has(`${base}_${i}`)) i++
  return `${base}_${i}`
}

// Random 8-char base-36 ID (same as Personnel.jsx)
function newMusicianId() {
  return Math.random().toString(36).slice(2, 10)
}

// ── Row parser ────────────────────────────────────────────────────────────────
// Takes raw CSV text; returns { rows: ParsedRow[], warnings: string[] }
// Each ParsedRow has all fields resolved but musician IDs are not yet assigned.

function parseBookingCsv(text) {
  const allRows = parseCsv(text)
  if (allRows.length < 2) throw new Error('CSV appears empty or has no data rows')

  // Build column-index map from the header row
  const header = allRows[0]
  const col = {}
  header.forEach((h, i) => { col[h.trim()] = i })

  // Verify required columns exist
  const required = ['Date', 'Venue']
  for (const c of required) {
    if (col[c] === undefined) throw new Error(`Missing required column: "${c}"`)
  }

  const warnings = []
  const rows = []

  // Collect musician names → Set of parts they played, for creating musician records
  // Map<lowerName → { displayName, parts: Set<appPart> }>
  const musicianIndex = new Map()

  for (let r = 1; r < allRows.length; r++) {
    const row = allRows[r]
    const raw = (colName) => (col[colName] !== undefined ? row[col[colName]] || '' : '').trim()

    const dateStr = parseDate(raw('Date'))
    if (!dateStr) continue   // blank / total / separator row

    const venue = raw('Venue')
    if (!venue) { warnings.push(`Row ${r + 1}: skipped — no venue`); continue }

    const { start: time, end: endTime } = parseTime(raw('Time'))
    const { value: contractPay, mode: contractMode } = parseContractPay(raw('Contract Pay'))

    // Collect lineup for this row
    const lineupNames = {}   // appPart → name | null
    for (const { csvCol, appPart } of LINEUP_COLS) {
      const name = raw(csvCol)
      const valid = name && name.toLowerCase() !== 'na'
      lineupNames[appPart] = valid ? name : null

      if (valid) {
        const key = name.toLowerCase()
        if (!musicianIndex.has(key)) {
          musicianIndex.set(key, { displayName: name, parts: new Set() })
        }
        musicianIndex.get(key).parts.add(appPart)
      }
    }

    // Parse financials
    const venuePay    = parseDollar(raw('Venue pay'))
    const cashTips    = parseDollar(raw('Cash tips'))
    const venmoTips   = parseDollar(raw('Venmo'))
    const outOfPocket = parseDollar(raw('Out of pocket'))   // negative in CSV
    const paidPer     = parseDollar(raw('Paid per person'))

    rows.push({
      dateStr,
      venue,
      bandName:    raw('Band name') || null,
      time,
      endTime,
      lineupNames,
      financials: {
        contract_pay:        contractPay,
        contract_pay_mode:   contractMode,
        venue_pay:           venuePay,
        cash_tips:           cashTips,
        venmo_tips:          venmoTips,
        // Out-of-pocket is stored as a positive number; UI subtracts it.
        extra_expenses:      outOfPocket !== null ? Math.abs(outOfPocket) : null,
        extra_expenses_memo: '',
        paid_per_person:     paidPer,
        exclude_bandleader:  true,
        paid_musicians:      {},
      },
    })
  }

  return { rows, warnings, musicianIndex }
}

// ── BookingImport ─────────────────────────────────────────────────────────────

function BookingImport() {
  // 'idle' → file selected → 'parsed' → import clicked → 'importing' → 'done' | 'error'
  const [stage,    setStage]    = useState('idle')
  const [parsed,   setParsed]   = useState(null)    // { rows, warnings, musicianIndex }
  const [result,   setResult]   = useState(null)
  const [errorMsg, setErrorMsg] = useState(null)

  function handleFile(e) {
    const file = e.target.files[0]
    if (!file) return
    setStage('idle'); setParsed(null); setResult(null); setErrorMsg(null)

    const reader = new FileReader()
    reader.onload = ev => {
      try {
        const data = parseBookingCsv(ev.target.result)
        setParsed(data)
        setStage('parsed')
      } catch (err) {
        setErrorMsg(`Parse error: ${err.message}`)
      }
    }
    reader.readAsText(file)
  }

  async function handleImport() {
    if (!parsed || !parsed.rows.length) return
    setStage('importing')
    setErrorMsg(null)

    try {
      const { rows, musicianIndex } = parsed

      // ── 1. Resolve musicians ───────────────────────────────────────────────
      // Load all existing musicians; build name (lowercase) → id map
      const existing = await db.exec('SELECT id, name FROM musicians')
      const nameToId = new Map(existing.map(m => [m.name.toLowerCase(), m.id]))

      let musiciansCreated = 0
      for (const [lowerName, { displayName, parts }] of musicianIndex) {
        if (!nameToId.has(lowerName)) {
          const id = newMusicianId()
          await db.run(
            `INSERT INTO musicians (id, name, parts, city, state, locked)
             VALUES (?, ?, ?, NULL, NULL, 0)`,
            [id, displayName, JSON.stringify([...parts])]
          )
          nameToId.set(lowerName, id)
          musiciansCreated++
        }
      }
      if (musiciansCreated > 0) saveMusiciansToDrive()

      // ── 2. Load defaults ───────────────────────────────────────────────────
      const partsRow = await db.exec(`SELECT value FROM settings WHERE key = 'active_parts'`)
      const activeParts = partsRow.length ? JSON.parse(partsRow[0].value) : []

      // Pre-load all existing gig IDs to generate collision-free slugs
      const existingGigs = await db.exec('SELECT id FROM gigs')
      const usedIds = new Set(existingGigs.map(g => g.id))

      // ── 3. Insert gigs ─────────────────────────────────────────────────────
      let gigsCreated = 0
      let gigsSkipped = 0

      await db.transaction(async tx => {
        for (const row of rows) {
          const gigId = makeGigId(row.venue, row.dateStr, usedIds)
          usedIds.add(gigId)

          // Build lineup: { appPart: { assigned: id|null, declined: [] } }
          const lineup = {}
          for (const { appPart } of LINEUP_COLS) {
            const name = row.lineupNames[appPart]
            lineup[appPart] = {
              assigned: name ? (nameToId.get(name.toLowerCase()) ?? null) : null,
              declined: [],
            }
          }

          // Check for exact duplicate (same id — shouldn't happen, but be safe)
          const dup = await tx.exec('SELECT id FROM gigs WHERE id = ?', [gigId])
          if (dup.length > 0) { gigsSkipped++; continue }

          await tx.run(
            `INSERT INTO gigs
               (id, name, date, venue, band_name, time, end_time,
                setlist, print_sublists, locked, parts, lineup, financials)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
            [
              gigId,
              row.venue,               // name = venue; user can rename in editor
              row.dateStr,
              row.venue,
              row.bandName,
              row.time,
              row.endTime,
              JSON.stringify([]),       // setlist populated separately
              JSON.stringify([]),
              JSON.stringify(activeParts),
              JSON.stringify(lineup),
              JSON.stringify(row.financials),
            ]
          )
          gigsCreated++
        }
      })

      saveGigsToDrive()

      setResult({ gigsCreated, gigsSkipped, musiciansCreated })
      setStage('done')
    } catch (err) {
      console.error('[Import] Booking import failed:', err)
      setErrorMsg(`Import failed: ${err.message}`)
      setStage('parsed')   // allow retry
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  // Summary row: musician list abbreviation for preview table
  function lineupSummary(lineupNames) {
    return Object.values(lineupNames)
      .filter(Boolean)
      .map(n => n.split(' ')[0])  // first name only for brevity
      .join(', ') || '—'
  }

  function fmtDollar(n) {
    if (n == null) return ''
    return '$' + Math.round(n).toLocaleString()
  }

  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>Booking Info</h3>
      <p className={styles.hint}>
        Export the <em>Austin booking info</em> sheet as CSV and select it below.
        Gig setlists are not imported here — use the Setlist section below once
        gigs are created. All imported gigs are created locked; unlock individually
        in the Gig editor to make changes.
      </p>

      {stage !== 'done' && (
        <label className={styles.fileLabel}>
          <span className={styles.fileLabelText}>Select CSV file</span>
          <input
            type="file"
            accept=".csv,text/csv"
            className={styles.fileInput}
            onChange={handleFile}
          />
        </label>
      )}

      {errorMsg && <p className={styles.errorMsg}>{errorMsg}</p>}

      {/* ── Preview table ── */}
      {parsed && stage !== 'done' && (
        <div className={styles.preview}>
          <p className={styles.previewSummary}>
            <strong>{parsed.rows.length}</strong> gigs found &nbsp;·&nbsp;{' '}
            <strong>{parsed.musicianIndex.size}</strong> unique musicians in CSV
            {parsed.warnings.length > 0 && (
              <span className={styles.warnCount}> &nbsp;·&nbsp; {parsed.warnings.length} warning{parsed.warnings.length > 1 ? 's' : ''}</span>
            )}
          </p>

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Venue</th>
                  <th>Band</th>
                  <th>Musicians</th>
                  <th>Pay</th>
                </tr>
              </thead>
              <tbody>
                {parsed.rows.map((row, i) => (
                  <tr key={i}>
                    <td className={styles.tdDate}>{row.dateStr}</td>
                    <td>{row.venue}</td>
                    <td className={styles.tdBand}>{row.bandName || '—'}</td>
                    <td className={styles.tdLineup}>{lineupSummary(row.lineupNames)}</td>
                    <td className={styles.tdPay}>
                      {fmtDollar(
                        (row.financials.venue_pay ?? 0) +
                        (row.financials.cash_tips ?? 0) +
                        (row.financials.venmo_tips ?? 0) -
                        (row.financials.extra_expenses ?? 0)
                      ) || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {parsed.warnings.length > 0 && (
            <details className={styles.warnings}>
              <summary>Warnings ({parsed.warnings.length})</summary>
              <ul>
                {parsed.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </details>
          )}

          <div className={styles.actions}>
            <button
              className={styles.importBtn}
              onClick={handleImport}
              disabled={stage === 'importing'}
            >
              {stage === 'importing' ? 'Importing…' : `Import ${parsed.rows.length} gigs`}
            </button>
          </div>
        </div>
      )}

      {/* ── Result ── */}
      {stage === 'done' && result && (
        <div className={styles.result}>
          <p className={styles.resultLine}>
            ✓ <strong>{result.gigsCreated}</strong> gig{result.gigsCreated !== 1 ? 's' : ''} imported
          </p>
          {result.musiciansCreated > 0 && (
            <p className={styles.resultLine}>
              ✓ <strong>{result.musiciansCreated}</strong> new musician{result.musiciansCreated !== 1 ? 's' : ''} created
            </p>
          )}
          {result.gigsSkipped > 0 && (
            <p className={styles.resultLine}>
              {result.gigsSkipped} row{result.gigsSkipped !== 1 ? 's' : ''} skipped (duplicate ID)
            </p>
          )}
          <p className={styles.resultHint}>
            Gigs are visible in the Gigs tab. Unlock a gig to edit its details.
            Use the Setlist section below to attach setlists.
          </p>
        </div>
      )}
    </section>
  )
}

// ── SetlistImport ─────────────────────────────────────────────────────────────
// Placeholder — implementation requires the setlist sheet format.

function SetlistImport() {
  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>Setlists</h3>
      <p className={styles.hint}>
        Provide the setlist spreadsheet and its column layout to enable this section.
        Once configured, it will match rows to already-imported gigs by date and venue
        and populate their setlists.
      </p>
      <div className={styles.placeholder}>
        Awaiting setlist CSV format
      </div>
    </section>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Import() {
  return (
    <div className={styles.page}>
      <h2 className={styles.pageTitle}>Import</h2>
      <p className={styles.pageDesc}>
        One-time import of historical gig data from spreadsheet exports.
        Imported records are created as drafts for you to review and clean up.
      </p>
      <BookingImport />
      <SetlistImport />
    </div>
  )
}
