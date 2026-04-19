// src/drive/sync.js
// Syncs the Google Drive song library into SQLite.
//
// Folder structure expected:
//   <master folder>/
//     <index> <title>/          e.g. "1014 There ain't no sweet man"
//     <index>#<key> <title>/    e.g. "1023#Am No Moon At All"
//       <index> - <title> - <part>.pdf
//
// On each sync:
//   1. Find the master folder by name
//   2. List all subfolders
//   3. For each subfolder: parse name, list PDFs, build parts dict
//   4. Upsert into SQLite songs table
//   5. Mark folders no longer in Drive as inactive (soft delete)

import { db } from '../db/index.js'
import { saveSettingsToDrive } from './sync-gigs.js'

// ── Folder name parser ─────────────────────────────────────────────────────
// Matches: "1014 There ain't no sweet man"
//          "1023#Am No Moon At All"
//          "3015#Eb Ain't Misbehavin'"
const FOLDER_RE = /^(\d{4})(#[A-Za-z]+)?\s+(.+)$/

export function parseFolderName(name) {
  const match = name.match(FOLDER_RE)
  if (!match) return null
  const [, idx, keyRaw, title] = match
  const keyVariant = keyRaw ? keyRaw.slice(1) : null // strip leading #
  const id = keyVariant ? `${idx}#${keyVariant}` : idx
  return { id, idx, keyVariant, title: title.trim() }
}

// ── PDF part name parser ───────────────────────────────────────────────────
// Matches: "1014 - There ain't no sweet man - Vocals.pdf"
// Returns the part name portion (lowercased)
const PDF_RE = /^.+\s-\s.+\s-\s(.+)\.pdf$/i

export function parsePartName(filename) {
  const match = filename.match(PDF_RE)
  if (!match) return null
  return match[1].trim().toLowerCase()
}

// ── Type/subtype lookup ────────────────────────────────────────────────────
let _typeMap = null

async function getTypeMap() {
  if (_typeMap) return _typeMap
  const rows = await db.exec(`SELECT value FROM settings WHERE key = 'type_map'`)
  _typeMap = rows.length ? JSON.parse(rows[0].value) : {}
  return _typeMap
}

export function deriveType(idx) {
  const prefix = idx.slice(0, 2)
  return { prefix, type: null, subtype: null } // resolved via typeMap in caller
}

// ── Blacklist ──────────────────────────────────────────────────────────────
let _blacklist = null

async function getBlacklist() {
  if (_blacklist) return _blacklist
  const rows = await db.exec(`SELECT value FROM settings WHERE key = 'blacklist'`)
  _blacklist = rows.length ? JSON.parse(rows[0].value) : []
  return _blacklist
}

// ── Drive API helpers ──────────────────────────────────────────────────────

async function driveList(params) {
  // gapi.client.drive.files.list wrapper with automatic pagination
  const fields = params.fields || 'files(id,name,mimeType),nextPageToken'
  let allFiles = []
  let pageToken = null

  do {
    const response = await window.gapi.client.drive.files.list({
      ...params,
      fields,
      pageSize: 1000,
      ...(pageToken ? { pageToken } : {}),
    })
    const result = response.result
    allFiles = allFiles.concat(result.files || [])
    pageToken = result.nextPageToken || null
  } while (pageToken)

  return allFiles
}

async function findMasterFolder(name) {
  const files = await driveList({
    q: `name = '${name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id,name)',
  })
  return files[0] || null
}

async function listSubfolders(parentId) {
  return driveList({
    q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id,name)',
  })
}

async function listPdfs(folderId) {
  return driveList({
    q: `'${folderId}' in parents and mimeType = 'application/pdf' and trashed = false`,
    fields: 'files(id,name)',
  })
}

// ── Main sync function ─────────────────────────────────────────────────────

/**
 * Sync the Drive song library into SQLite.
 * @param {function} onProgress - callback(message, current, total)
 * @returns {{ added, updated, skipped, inactive, warnings }}
 */
export async function syncLibrary(onProgress = () => {}) {
  const typeMap = await getTypeMap()
  const blacklist = await getBlacklist()

  // Reset cached config so changes in settings take effect
  _typeMap = null
  _blacklist = null

  // 1. Find root Drive folder
  const rows = await db.exec(`SELECT value FROM settings WHERE key = 'root_drive_folder'`)
  const masterFolderName = rows.length ? JSON.parse(rows[0].value) : 'The Vintage Ties 2021'

  onProgress(`Finding "${masterFolderName}" in Google Drive…`, 0, 0)
  const masterFolder = await findMasterFolder(masterFolderName)

  if (!masterFolder) {
    throw new Error(`Could not find folder "${masterFolderName}" in Google Drive. Make sure it has been shared with your account.`)
  }

  // 2. List all subfolders
  onProgress('Listing song folders…', 0, 0)
  const subfolders = await listSubfolders(masterFolder.id)

  const stats = { added: 0, updated: 0, skipped: 0, inactive: 0, warnings: [] }
  const seenIds = new Set()

  // 3. Process each subfolder
  for (let i = 0; i < subfolders.length; i++) {
    const folder = subfolders[i]
    onProgress(`Scanning ${folder.name}…`, i + 1, subfolders.length)

    // Parse folder name
    const parsed = parseFolderName(folder.name)
    if (!parsed) {
      stats.warnings.push(`Skipped unrecognised folder name: "${folder.name}"`)
      stats.skipped++
      continue
    }

    const { id, idx, keyVariant } = parsed
  // Drive folder names use underscores instead of apostrophes because
  // apostrophes cause issues in some Drive/filesystem naming contexts.
  // e.g. "I_ve Heard That Song Before" → "I've Heard That Song Before"
  const title = parsed.title.replace(/_/g, "'")

    // Check blacklist
    const isBlacklisted = blacklist.includes(idx) || blacklist.includes(id)

    // Derive type/subtype from index prefix
    const prefix = idx.slice(0, 2)
    const typeEntry = typeMap[prefix]
    if (!typeEntry && !isBlacklisted) {
      stats.warnings.push(`Unknown type prefix "${prefix}" for song ${id} "${title}"`)
    }
    const songType = typeEntry?.type || 'Unknown'
    const subtype = typeEntry?.subtype || 'Unknown'

    // List PDFs inside the folder
    const pdfs = await listPdfs(folder.id)
    const parts = {}
    for (const pdf of pdfs) {
      const partName = parsePartName(pdf.name)
      if (partName) {
        parts[partName] = pdf.id
      } else {
        stats.warnings.push(`Could not parse part name from: "${pdf.name}"`)
      }
    }

    seenIds.add(id)

    // Upsert into SQLite
    const existing = await db.exec(`SELECT id FROM songs WHERE id = ?`, [id])
    const partsJson = JSON.stringify(parts)
    const now = Date.now()

    if (existing.length === 0) {
      await db.run(
        `INSERT INTO songs (id, idx, key_variant, title, song_type, subtype, drive_folder_id, parts, blacklisted, active, last_synced)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        [id, idx, keyVariant, title, songType, subtype, folder.id, partsJson, isBlacklisted ? 1 : 0, now]
      )
      stats.added++
    } else {
      await db.run(
        `UPDATE songs SET title = ?, song_type = ?, subtype = ?, drive_folder_id = ?,
         parts = ?, blacklisted = ?, active = 1, last_synced = ?
         WHERE id = ?`,
        [title, songType, subtype, folder.id, partsJson, isBlacklisted ? 1 : 0, now, id]
      )
      stats.updated++
    }
  }

  // 4. Mark songs no longer in Drive as inactive
  const allSongs = await db.exec(`SELECT id FROM songs WHERE active = 1`)
  for (const song of allSongs) {
    if (!seenIds.has(song.id)) {
      await db.run(`UPDATE songs SET active = 0 WHERE id = ?`, [song.id])
      stats.inactive++
    }
  }

  // 5. Record sync timestamp
  await db.run(
    `INSERT OR REPLACE INTO settings (key, value) VALUES ('last_synced', ?)`,
    [JSON.stringify(Date.now())]
  )
  saveSettingsToDrive()  // fire-and-forget — persists last_synced to Drive

  onProgress('Sync complete.', subfolders.length, subfolders.length)
  return stats
}