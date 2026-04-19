// src/drive/sync-gigs.js
// Drive serialisation for gig and settings records.
//
// Sync files live in a `Fletcher Sync` sub-folder inside the user's configured
// root Drive folder (same top-level folder used for song sync and exports).
//
// File layout:
//   <root_drive_folder>/
//     Fletcher Sync/
//       gigs.info      — { version, savedAt, gigs: [ <row>, … ] }
//       settings.info  — { version, savedAt, settings: [ { key, value }, … ] }
//
// All public functions are non-fatal: errors are logged but never propagate,
// so a Drive outage never blocks the local UI.

import { db } from '../db/index.js'
import { tokenExpiresIn, refreshAccessToken } from '../auth/google.js'

const SYNC_FOLDER_NAME    = 'Fletcher Sync'
const GIGS_FILE_NAME      = 'gigs.info'
const SETTINGS_FILE_NAME  = 'settings.info'
const MUSICIANS_FILE_NAME = 'musicians.info'
const FILE_VERSION        = 1

// Keys that are internal DB flags, not user preferences — excluded from sync.
const SETTINGS_EXCLUDE = new Set(['seeded'])

// ── Auth helpers ──────────────────────────────────────────────────────────────

function getToken() {
  return window.gapi?.client?.getToken()?.access_token
    || sessionStorage.getItem('access_token')
}

async function ensureToken() {
  if (tokenExpiresIn() < 60_000) {
    await refreshAccessToken().catch(() => {})
  }
}

// ── Drive utilities ───────────────────────────────────────────────────────────

async function gapiExec(fn) {
  try {
    return await fn()
  } catch (err) {
    const msg = err?.result?.error?.message
              || err?.message
              || `Drive API error (status ${err?.status ?? 'unknown'})`
    throw new Error(msg)
  }
}

function driveEscape(str) {
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

// Walk the user's configured root_drive_folder path and return the folder ID.
// Returns null if the setting is missing or the root folder isn't found in Drive.
async function resolveRootFolder() {
  const rows = await db.exec(`SELECT value FROM settings WHERE key = 'root_drive_folder'`)
  if (rows.length === 0) return null
  const folderPath = JSON.parse(rows[0].value)
  if (!folderPath) return null

  const segments = folderPath.split('/').map(s => s.trim()).filter(Boolean)
  if (segments.length === 0) return null

  // The first segment must already exist at the Drive root.
  const rootResp = await gapiExec(() => window.gapi.client.drive.files.list({
    q: `name = '${driveEscape(segments[0])}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id)',
    pageSize: 1,
  }))
  if (!rootResp.result.files?.length) return null
  let current = rootResp.result.files[0]

  for (const seg of segments.slice(1)) {
    const resp = await gapiExec(() => window.gapi.client.drive.files.list({
      q: `name = '${driveEscape(seg)}' and '${current.id}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id)',
      pageSize: 1,
    }))
    if (!resp.result.files?.length) return null
    current = resp.result.files[0]
  }
  return current.id
}

/**
 * Walk `folderPath` in Drive and return true if every segment exists.
 * Used to validate a new root folder value before saving it.
 * Throws if Drive is unreachable (auth error, network, etc.).
 */
export async function checkRootFolderExists(folderPath) {
  const segments = (folderPath || '').split('/').map(s => s.trim()).filter(Boolean)
  if (segments.length === 0) return false

  const rootResp = await gapiExec(() => window.gapi.client.drive.files.list({
    q: `name = '${driveEscape(segments[0])}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id)',
    pageSize: 1,
  }))
  if (!rootResp.result.files?.length) return false
  let current = rootResp.result.files[0]

  for (const seg of segments.slice(1)) {
    const resp = await gapiExec(() => window.gapi.client.drive.files.list({
      q: `name = '${driveEscape(seg)}' and '${current.id}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id)',
      pageSize: 1,
    }))
    if (!resp.result.files?.length) return false
    current = resp.result.files[0]
  }
  return true
}

// Find the `Fletcher Sync` folder inside the root Drive folder.
// Creates it if absent; returns null if the root folder isn't configured/found.
async function getSyncFolder() {
  const rootId = await resolveRootFolder()
  if (!rootId) return null

  // Check for existing folder first; create only if absent.
  const resp = await gapiExec(() => window.gapi.client.drive.files.list({
    q: `name = '${driveEscape(SYNC_FOLDER_NAME)}' and '${rootId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id)',
    pageSize: 1,
  }))
  if (resp.result.files?.length) return resp.result.files[0].id

  const created = await gapiExec(() => window.gapi.client.drive.files.create({
    resource: { name: SYNC_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder', parents: [rootId] },
    fields: 'id',
  }))
  return created.result.id
}

// Return the Drive file ID of `name` inside `parentId`, or null if absent.
async function findFile(name, parentId) {
  const resp = await gapiExec(() => window.gapi.client.drive.files.list({
    q: `name = '${driveEscape(name)}' and '${parentId}' in parents and trashed = false`,
    fields: 'files(id)',
    pageSize: 1,
  }))
  return resp.result.files?.[0]?.id ?? null
}

// Download the content of a Drive file as parsed JSON.
async function downloadJson(fileId) {
  const resp = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${getToken()}` } }
  )
  if (!resp.ok) throw new Error(`Download failed (${resp.status})`)
  return resp.json()
}

// Upload a new JSON file via multipart upload; returns the new file ID.
async function createJsonFile(name, data, parentId) {
  const json     = JSON.stringify(data)
  const metadata = JSON.stringify({ name, mimeType: 'application/json', parents: [parentId] })
  const boundary = 'fletcher_sync_boundary'
  const body     = [
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}`,
    `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${json}`,
    `\r\n--${boundary}--`,
  ].join('')

  const resp = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${getToken()}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  )
  if (!resp.ok) throw new Error(`Create failed (${resp.status}): ${await resp.text()}`)
  return (await resp.json()).id
}

// Overwrite an existing Drive file's content via PATCH multipart.
async function updateJsonFile(fileId, data) {
  const json     = JSON.stringify(data)
  const metadata = JSON.stringify({ mimeType: 'application/json' })
  const boundary = 'fletcher_sync_boundary'
  const body     = [
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}`,
    `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${json}`,
    `\r\n--${boundary}--`,
  ].join('')

  const resp = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${getToken()}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  )
  if (!resp.ok) throw new Error(`Update failed (${resp.status}): ${await resp.text()}`)
}

// Write data to Drive: create the file if absent, overwrite if present.
async function upsertJsonFile(name, data, syncFolderId) {
  const existingId = await findFile(name, syncFolderId)
  if (existingId) {
    await updateJsonFile(existingId, data)
  } else {
    await createJsonFile(name, data, syncFolderId)
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Download `settings.info` and apply it to the local settings table.
 * Skips internal flags (`seeded`).  Called before loadGigsFromDrive so that
 * the root_drive_folder path is up-to-date for any subsequent operations.
 */
export async function loadSettingsFromDrive() {
  try {
    await db.ready
    await ensureToken()

    const syncFolderId = await getSyncFolder()
    if (!syncFolderId) return  // root folder not configured or not found in Drive

    const fileId = await findFile(SETTINGS_FILE_NAME, syncFolderId)
    if (!fileId) return  // no file yet — first ever use

    const data = await downloadJson(fileId)
    if (!Array.isArray(data.settings)) {
      console.warn('[sync] settings.info has unexpected format — skipping load')
      return
    }

    for (const { key, value } of data.settings) {
      if (SETTINGS_EXCLUDE.has(key)) continue
      await db.run(
        `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
        [key, value]
      )
    }
    console.log(`[sync] Loaded ${data.settings.length} setting(s) from Drive`)
  } catch (err) {
    console.error('[sync] loadSettingsFromDrive failed:', err)
  }
}

/**
 * Serialise all settings (except internal flags) to `settings.info` on Drive.
 * Call fire-and-forget after any settings mutation.
 */
export async function saveSettingsToDrive() {
  try {
    await ensureToken()

    const syncFolderId = await getSyncFolder()
    if (!syncFolderId) return  // root folder not configured or not found in Drive

    const rows = await db.exec(`SELECT key, value FROM settings ORDER BY key`)
    const filtered = rows.filter(r => !SETTINGS_EXCLUDE.has(r.key))

    await upsertJsonFile(SETTINGS_FILE_NAME, {
      version:  FILE_VERSION,
      savedAt:  new Date().toISOString(),
      settings: filtered,
    }, syncFolderId)
    console.log(`[sync] Saved ${filtered.length} setting(s) to Drive`)
  } catch (err) {
    console.error('[sync] saveSettingsToDrive failed:', err)
  }
}

/**
 * Download `gigs.info` and re-populate the local gigs table.
 * Called once at sign-in, after loadSettingsFromDrive.
 */
export async function loadGigsFromDrive() {
  try {
    await db.ready
    await ensureToken()

    const syncFolderId = await getSyncFolder()
    if (!syncFolderId) return  // root folder not configured or not found in Drive

    const fileId = await findFile(GIGS_FILE_NAME, syncFolderId)
    if (!fileId) return  // no file yet — keep seeded data

    const data = await downloadJson(fileId)
    if (!Array.isArray(data.gigs)) {
      console.warn('[sync] gigs.info has unexpected format — skipping load')
      return
    }

    await db.run('DELETE FROM gigs')
    for (const gig of data.gigs) {
      await db.run(
        `INSERT INTO gigs (id, name, band_name, date, time, end_time, venue, city, state, setlist, print_sublists, locked, parts, lineup)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          gig.id,
          gig.name,
          gig.band_name      ?? null,
          gig.date           ?? null,
          gig.time           ?? null,
          gig.end_time       ?? null,
          gig.venue          ?? null,
          gig.city           ?? null,
          gig.state          ?? null,
          gig.setlist        ?? '[]',
          gig.print_sublists ?? '[]',
          gig.locked         ?? 0,
          gig.parts          ?? null,
          gig.lineup         ?? null,
        ]
      )
    }
    console.log(`[sync] Loaded ${data.gigs.length} gig(s) from Drive`)
  } catch (err) {
    console.error('[sync] loadGigsFromDrive failed:', err)
  }
}

/**
 * Serialise all gigs to `gigs.info` on Drive.
 * Call fire-and-forget after any gig mutation.
 */
export async function saveGigsToDrive() {
  try {
    await ensureToken()

    const syncFolderId = await getSyncFolder()
    if (!syncFolderId) return  // root folder not configured or not found in Drive

    const rows = await db.exec(
      `SELECT id, name, band_name, date, time, end_time, venue, city, state, setlist, print_sublists, locked, parts, lineup
       FROM gigs ORDER BY date DESC, name ASC`
    )

    await upsertJsonFile(GIGS_FILE_NAME, {
      version: FILE_VERSION,
      savedAt: new Date().toISOString(),
      gigs:    rows,
    }, syncFolderId)
    console.log(`[sync] Saved ${rows.length} gig(s) to Drive`)
  } catch (err) {
    console.error('[sync] saveGigsToDrive failed:', err)
  }
}

/**
 * Download `musicians.info` and re-populate the local musicians table.
 * Called once at sign-in, after settings and gigs are loaded.
 */
export async function loadMusiciansFromDrive() {
  try {
    await db.ready
    await ensureToken()

    const syncFolderId = await getSyncFolder()
    if (!syncFolderId) return

    const fileId = await findFile(MUSICIANS_FILE_NAME, syncFolderId)
    if (!fileId) return  // no file yet — table stays empty

    const data = await downloadJson(fileId)
    if (!Array.isArray(data.musicians)) {
      console.warn('[sync] musicians.info has unexpected format — skipping load')
      return
    }

    await db.run('DELETE FROM musicians')
    for (const m of data.musicians) {
      await db.run(
        `INSERT INTO musicians (id, name, parts, city, state, locked) VALUES (?, ?, ?, ?, ?, ?)`,
        [m.id, m.name, m.parts ?? '[]', m.city ?? null, m.state ?? null, m.locked ?? 0]
      )
    }
    console.log(`[sync] Loaded ${data.musicians.length} musician(s) from Drive`)
  } catch (err) {
    console.error('[sync] loadMusiciansFromDrive failed:', err)
  }
}

/**
 * Serialise all musicians to `musicians.info` on Drive.
 * Call fire-and-forget after any musician mutation.
 */
export async function saveMusiciansToDrive() {
  try {
    await ensureToken()

    const syncFolderId = await getSyncFolder()
    if (!syncFolderId) return

    const rows = await db.exec(
      `SELECT id, name, parts, city, state, locked FROM musicians ORDER BY name ASC`
    )

    await upsertJsonFile(MUSICIANS_FILE_NAME, {
      version:   FILE_VERSION,
      savedAt:   new Date().toISOString(),
      musicians: rows,
    }, syncFolderId)
    console.log(`[sync] Saved ${rows.length} musician(s) to Drive`)
  } catch (err) {
    console.error('[sync] saveMusiciansToDrive failed:', err)
  }
}
