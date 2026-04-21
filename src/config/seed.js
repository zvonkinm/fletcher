// src/config/seed.js
// Runs once when the database is empty.
// Inserts: type map, part definitions, blacklist, active parts, master folder,
// export folder, and 5 historical gigs.

// ── Config defaults ────────────────────────────────────────────────────────

const TYPE_MAP = {
  '10': { type: 'Arrangements', subtype: 'Swing' },
  '11': { type: 'Arrangements', subtype: '12 Bar' },
  '12': { type: 'Arrangements', subtype: 'Bluesy' },
  '20': { type: 'Instrumentals', subtype: 'Swing' },
  '21': { type: 'Instrumentals', subtype: '12 Bar' },
  '30': { type: 'Lead Sheet', subtype: 'Swing' },
  '31': { type: 'Lead Sheet', subtype: '12 Bar' },
  '32': { type: 'Lead Sheet', subtype: 'Bluesy' },
}

const PART_DEFINITIONS = {
  Vocals: {
    raw: ['voice', 'vocals', 'piano'],
    alt: ['Full Score', 'Lead Sheet C', 'Rhythm Section', 'Rhythm Guitar'],
  },
  Clarinet: {
    raw: ['clarinet', 'clarinet in bb'],
    alt: ['Lead Sheet Bb', 'Tenor Saxophone'],
  },
  'Tenor Saxophone': {
    raw: ['tenor saxophone'],
    alt: ['Clarinet', 'Lead Sheet Bb'],
  },
  'Electric Guitar': {
    raw: ['jazz guitar', 'electric guitar'],
    alt: ['Lead Sheet C', 'Vocals', 'Rhythm Section'],
  },
  'Rhythm Guitar': {
    raw: ['rhythm guitar'],
    alt: ['Rhythm Section', 'Lead Sheet C', 'Vocals', 'Acoustic Guitar'],
  },
  Bass: {
    raw: ['upright bass', 'string bass', 'rhythm section'],
    alt: ['Rhythm Section', 'Lead Sheet C', 'Vocals'],
  },
  Drums: {
    raw: ['drum set', 'rhythm section'],
    alt: ['Rhythm Section', 'Lead Sheet C', 'Vocals'],
  },
  Trumpet: {
    raw: ['trumpet bb', 'trumpet in bb'],
    alt: ['Clarinet', 'Lead Sheet Bb', 'Tenor Saxophone'],
  },
  // Internal parts — used in alt chains only, never printed directly
  Concert: {
    raw: ['concert'],
    alt: ['Electric Guitar', 'Lead Sheet C'],
  },
  'Bb instrument': {
    raw: ['bb instrument'],
    alt: ['Clarinet', 'Lead Sheet Bb'],
  },
  'Lead Sheet C': {
    raw: ['concert', 'concert ', 'lead sheet'],
  },
  'Lead Sheet Bb': {
    raw: ['bb instrument', 'bb instruments'],
  },
  'Rhythm Section': {
    raw: ['rhythm section'],
  },
}

const BLACKLIST = ['ZZZZ', '1020']

const ACTIVE_PARTS = [
  'Vocals',
  'Clarinet',
  'Tenor Saxophone',
  'Electric Guitar',
  'Rhythm Guitar',
  'Bass',
  'Drums',
  'Trumpet',
]

// Top-level Drive folder — root for all exports and sync files.
// Structure: <ROOT_DRIVE_FOLDER>/Setlists/<gig name>/<part>/
//            <ROOT_DRIVE_FOLDER>/Fletcher Sync/gigs.info
//            <ROOT_DRIVE_FOLDER>/Fletcher Sync/settings.info
// Configurable in Settings.
const ROOT_DRIVE_FOLDER = 'Default Folder'

// Separate Drive folder containing the song PDF library (numbered subfolders).
// Supports slash-separated paths for nested folders, e.g. "SharedDrive/Repertoire".
// Configurable in Settings independently of ROOT_DRIVE_FOLDER.
const LIBRARY_DRIVE_FOLDER = 'Default Library'

// ── Historical gigs ────────────────────────────────────────────────────────

const SEED_GIGS = [
  {
    id: 'vtjb_highball_042026',
    name: 'VTJB Highball',
    date: '2026-04-01',
    setlist: [
      '1025','1014','3035','1013','3023','2015','1105','1026',
      '1029','3036','1018','2011','3034','1017','1005','2007','1023#Am',
    ],
  },
  {
    id: 'vtq_batch_0426',
    name: 'VTQ Batch',
    date: '2026-04-01',
    setlist: [
      '2004','3037','2017','3009','2012','3023','2102','3029',
      '3005','2010','2103','3031','2011','3016','2009','3015#Eb',
      '2001','3010','3028','2101','3018','3034','2003',
    ],
  },
  {
    id: 'vtjb_highball_0326',
    name: 'VTJB Highball',
    date: '2026-03-01',
    setlist: [
      '1001','3031','1102','1005','1105','2015','1025','1023#Am',
      '1029','1008','1018','1030','1013','2005','1017','1024','3025',
    ],
  },
  {
    id: 'vtq_batch_0326',
    name: 'VTQ Batch',
    date: '2026-03-01',
    setlist: [
      '2004','3031','2017','3037','2012','3032','2102','1027',
      '2016','2104','3039','2011','3016','2009','3015#Eb',
      '2018','2007','3010','2010','3028','3045','2003',
    ],
  },
  {
    id: 'vt_highball_02082026',
    name: 'VT Highball',
    date: '2026-02-08',
    setlist: [
      '1001','3031','1102','1025','2005','1017','2010','1005',
      '1023#Am','1008','2015','3023','1013','3041','1026','1103#Bb','3025',
    ],
  },
]

// ── Seed function ──────────────────────────────────────────────────────────

export async function seedIfEmpty(db) {
  // Check if settings already seeded
  const existing = await db.exec(
    `SELECT value FROM settings WHERE key = 'seeded'`
  )
  if (existing.length > 0) {
    console.log('[seed] Already seeded — skipping')
    return
  }

  console.log('[seed] First run — applying seed data')

  await db.transaction(async (tx) => {
    // Config settings
    const settings = [
      ['type_map', JSON.stringify(TYPE_MAP)],
      ['part_definitions', JSON.stringify(PART_DEFINITIONS)],
      ['blacklist', JSON.stringify(BLACKLIST)],
      ['active_parts', JSON.stringify(ACTIVE_PARTS)],
      ['root_drive_folder', JSON.stringify(ROOT_DRIVE_FOLDER)],
      ['library_drive_folder', JSON.stringify(LIBRARY_DRIVE_FOLDER)],
      ['seeded', JSON.stringify(true)],
    ]

    for (const [key, value] of settings) {
      await tx.run(
        `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
        [key, value]
      )
    }

    // Historical gigs — seeded as locked=1 so they are read-only by default.
    // The user must explicitly unlock a gig to edit it.
    // parts defaults to ACTIVE_PARTS for all seeded gigs; adjust per gig in the editor.
    for (const gig of SEED_GIGS) {
      await tx.run(
        `INSERT OR IGNORE INTO gigs (id, name, date, setlist, print_sublists, locked, parts)
         VALUES (?, ?, ?, ?, ?, 1, ?)`,
        [
          gig.id,
          gig.name,
          gig.date,
          JSON.stringify(gig.setlist),
          JSON.stringify([]),
          JSON.stringify(ACTIVE_PARTS),
        ]
      )
    }
  })

  console.log('[seed] Seed complete — config + 5 gigs inserted')
}
