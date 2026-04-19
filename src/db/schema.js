// src/db/schema.js
// Applies the database schema. Safe to call on every startup — uses
// CREATE TABLE IF NOT EXISTS throughout.

export async function applySchema(db) {
  // ── Songs ──────────────────────────────────────────────────────────────
  await db.run(`
    CREATE TABLE IF NOT EXISTS songs (
      id              TEXT PRIMARY KEY,   -- e.g. "1023", "1023#Am"
      idx             TEXT NOT NULL,      -- 4-digit index string e.g. "1023"
      key_variant     TEXT,               -- e.g. "Am", "Eb" — NULL for base
      title           TEXT NOT NULL,
      song_type       TEXT NOT NULL,      -- "Arrangements" | "Instrumentals" | "Lead Sheet"
      subtype         TEXT NOT NULL,      -- "Swing" | "12 Bar" | "Bluesy"
      drive_folder_id TEXT NOT NULL,
      parts           TEXT NOT NULL DEFAULT '{}',  -- JSON: {partName: fileId}
      blacklisted     INTEGER NOT NULL DEFAULT 0,
      active          INTEGER NOT NULL DEFAULT 1,
      last_synced     INTEGER             -- Unix timestamp ms
    )
  `)

  // ── Gigs ───────────────────────────────────────────────────────────────
  await db.run(`
    CREATE TABLE IF NOT EXISTS gigs (
      id             TEXT PRIMARY KEY,    -- slug e.g. "vtjb_highball_042026"
      name           TEXT NOT NULL,
      date           TEXT,                -- ISO 8601
      venue          TEXT,
      notes          TEXT,
      setlist        TEXT NOT NULL DEFAULT '[]',        -- JSON: string[]
      print_sublists TEXT NOT NULL DEFAULT '[]'         -- JSON: {name, song_ids[]}[]
    )
  `)

  // ── Settings (key/value store) ─────────────────────────────────────────
  await db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL    -- JSON-encoded value
    )
  `)

  // ── Musicians ──────────────────────────────────────────────────────────
  await db.run(`
    CREATE TABLE IF NOT EXISTS musicians (
      id     TEXT PRIMARY KEY,
      name   TEXT NOT NULL,
      parts  TEXT NOT NULL DEFAULT '[]',  -- JSON: string[] of part names
      locked INTEGER NOT NULL DEFAULT 0
    )
  `)

  // ── Indexes ────────────────────────────────────────────────────────────
  await db.run(`CREATE INDEX IF NOT EXISTS idx_songs_idx ON songs(idx)`)
  await db.run(`CREATE INDEX IF NOT EXISTS idx_songs_type ON songs(song_type, subtype)`)
  await db.run(`CREATE INDEX IF NOT EXISTS idx_gigs_date ON gigs(date DESC)`)

  // ── Schema migrations ───────────────────────────────────────────────────
  // SQLite does not support ALTER TABLE … ADD COLUMN IF NOT EXISTS, so we
  // inspect PRAGMA table_info first and only add columns that are missing.
  // This block runs on every startup and is safe to re-run on existing DBs.
  const gigCols = await db.exec('PRAGMA table_info(gigs)')
  const gigColNames = new Set(gigCols.map(c => c.name))

  if (!gigColNames.has('band_name')) {
    await db.run('ALTER TABLE gigs ADD COLUMN band_name TEXT')
    console.log('[db/schema] Migration: added gigs.band_name')
  }
  if (!gigColNames.has('time')) {
    await db.run('ALTER TABLE gigs ADD COLUMN time TEXT')
    console.log('[db/schema] Migration: added gigs.time')
  }
  if (!gigColNames.has('locked')) {
    await db.run('ALTER TABLE gigs ADD COLUMN locked INTEGER NOT NULL DEFAULT 0')
    // All pre-migration gigs are historic — lock them immediately.
    // New gigs created via GigForm will INSERT with locked=0 (unlocked).
    await db.run('UPDATE gigs SET locked = 1')
    console.log('[db/schema] Migration: added gigs.locked, locked existing gigs')
  }
  if (!gigColNames.has('parts')) {
    if (gigColNames.has('seats')) {
      // Rename the column that was added in the previous version of the app.
      await db.run('ALTER TABLE gigs RENAME COLUMN seats TO parts')
      console.log('[db/schema] Migration: renamed gigs.seats → gigs.parts')
    } else {
      // Fresh install — add the parts column directly.
      await db.run('ALTER TABLE gigs ADD COLUMN parts TEXT')
      // Populate existing gigs from active_parts (or fall back to active_seats
      // if the settings key hasn't been migrated yet on this run).
      const rows = await db.exec(
        `SELECT value FROM settings WHERE key IN ('active_parts','active_seats') ORDER BY key ASC LIMIT 1`
      )
      if (rows.length > 0) {
        await db.run('UPDATE gigs SET parts = ?', [rows[0].value])
      }
      console.log('[db/schema] Migration: added gigs.parts')
    }
  }

  // Migrate settings key active_seats → active_parts (one-time, safe to re-run).
  const oldActiveSeats = await db.exec(`SELECT value FROM settings WHERE key = 'active_seats'`)
  if (oldActiveSeats.length > 0) {
    await db.run(
      `INSERT OR IGNORE INTO settings (key, value) VALUES ('active_parts', ?)`,
      [oldActiveSeats[0].value]
    )
    await db.run(`DELETE FROM settings WHERE key = 'active_seats'`)
    console.log('[db/schema] Migration: renamed settings key active_seats → active_parts')
  }

  // Gig city / state / lineup columns (added for Line Up feature).
  if (!gigColNames.has('city')) {
    await db.run('ALTER TABLE gigs ADD COLUMN city TEXT')
    console.log('[db/schema] Migration: added gigs.city')
  }
  if (!gigColNames.has('state')) {
    await db.run('ALTER TABLE gigs ADD COLUMN state TEXT')
    console.log('[db/schema] Migration: added gigs.state')
  }
  if (!gigColNames.has('lineup')) {
    await db.run('ALTER TABLE gigs ADD COLUMN lineup TEXT')
    console.log('[db/schema] Migration: added gigs.lineup')
  }
  if (!gigColNames.has('end_time')) {
    await db.run('ALTER TABLE gigs ADD COLUMN end_time TEXT')
    console.log('[db/schema] Migration: added gigs.end_time')
  }

  // Musician city / state columns (added for Line Up feature).
  const musicianCols     = await db.exec('PRAGMA table_info(musicians)')
  const musicianColNames = new Set(musicianCols.map(c => c.name))
  if (!musicianColNames.has('city')) {
    await db.run('ALTER TABLE musicians ADD COLUMN city TEXT')
    console.log('[db/schema] Migration: added musicians.city')
  }
  if (!musicianColNames.has('state')) {
    await db.run('ALTER TABLE musicians ADD COLUMN state TEXT')
    console.log('[db/schema] Migration: added musicians.state')
  }

  // Migrate export_folder_name and master_folder_name → root_drive_folder.
  // Both pointed at the same top-level Drive folder; collapse into one key.
  for (const oldKey of ['export_folder_name', 'master_folder_name']) {
    const oldRow = await db.exec(`SELECT value FROM settings WHERE key = ?`, [oldKey])
    if (oldRow.length > 0) {
      await db.run(
        `INSERT OR IGNORE INTO settings (key, value) VALUES ('root_drive_folder', ?)`,
        [oldRow[0].value]
      )
      await db.run(`DELETE FROM settings WHERE key = ?`, [oldKey])
      console.log(`[db/schema] Migration: renamed settings key ${oldKey} → root_drive_folder`)
    }
  }

  console.log('[db/schema] Schema applied')
}
