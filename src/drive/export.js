// src/drive/export.js
// Exports a gig's setlist to Google Drive, mirroring the Colab notebook logic.
//
// Output structure:
//   <export_folder>/Setlists/<gig name>/<part>/
//     <songId> - <title> - <part>.pdf   ← individual copies (Drive files.copy)
//     ALL - <gig name> - <part>.pdf     ← per-part merge (pdf-lib, setlist order)
//   <export_folder>/Setlists/<gig name>/
//     ALL PARTS - <gig name>.pdf        ← full merge of all per-part merged PDFs
//
// Process (matching Colab's CreateCollection):
//   1. Resolve parts for every song × part (raw match → alt chain)
//   2. Find/create Drive folder tree; clear old PDFs in each part subfolder
//   3. Copy individual PDFs via Drive files.copy (no download needed)
//   4. Fetch originals, merge per part with pdf-lib, upload merged PDF
//   5. Concatenate all per-part merged PDFs, upload ALL PARTS file

import { PDFDocument } from 'pdf-lib'
import { db } from '../db/index.js'
import { fetchPdfBytes } from './files.js'

// ── Drive helpers ──────────────────────────────────────────────────────────

function getToken() {
  // Prefer the token gapi is actively using so raw fetch calls stay in sync
  // with gapi's auth state. Fall back to sessionStorage if gapi isn't loaded.
  return window.gapi?.client?.getToken()?.access_token
    || sessionStorage.getItem('access_token')
}

// ── gapi error normaliser ──────────────────────────────────────────────────
// gapi rejects with { status, result: { error: { message, code } }, body }
// rather than a standard Error object. This wrapper converts those rejections
// into proper Errors so callers always see err.message.
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

async function driveList(params) {
  // Paginated wrapper around gapi.client.drive.files.list
  const fields = params.fields || 'files(id,name),nextPageToken'
  let all = []
  let pageToken = null
  do {
    const resp = await gapiExec(() => window.gapi.client.drive.files.list({
      ...params,
      fields,
      pageSize: 1000,
      ...(pageToken ? { pageToken } : {}),
    }))
    all = all.concat(resp.result.files || [])
    pageToken = resp.result.nextPageToken || null
  } while (pageToken)
  return all
}

// Escape single quotes in Drive query strings
function driveEscape(str) {
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

async function findFolder(name, parentId) {
  const parentClause = parentId ? ` and '${parentId}' in parents` : ''
  const files = await driveList({
    q: `name = '${driveEscape(name)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false${parentClause}`,
    fields: 'files(id,name)',
  })
  return files[0] || null
}

async function createFolder(name, parentId) {
  const resp = await gapiExec(() => window.gapi.client.drive.files.create({
    resource: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentId ? { parents: [parentId] } : {}),
    },
    fields: 'id,name',
  }))
  return resp.result
}

async function findOrCreateFolder(name, parentId, onProgress) {
  const existing = await findFolder(name, parentId)
  if (existing) {
    onProgress(`  Folder found: ${name}`)
    return existing
  }
  onProgress(`  Creating folder: ${name}`)
  return createFolder(name, parentId)
}

async function clearPdfsInFolder(folderId) {
  // Delete all PDFs in a folder (mirrors Colab's ClearDir — re-export is clean)
  const pdfs = await driveList({
    q: `'${folderId}' in parents and mimeType = 'application/pdf' and trashed = false`,
    fields: 'files(id)',
  })
  for (const pdf of pdfs) {
    await gapiExec(() => window.gapi.client.drive.files.delete({ fileId: pdf.id }))
  }
  return pdfs.length
}

async function copyFile(fileId, name, parentId) {
  // Drive-side copy — no download required (mirrors Colab's files().copy())
  const resp = await gapiExec(() => window.gapi.client.drive.files.copy({
    fileId,
    resource: { name, parents: [parentId] },
    fields: 'id',
  }))
  return resp.result
}


async function uploadPdf(name, pdfBytes, parentId) {
  // Multipart upload: metadata JSON + binary PDF in one request
  // pdfBytes may be Uint8Array (from pdf-lib) or ArrayBuffer
  const bytes = pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes)
  const metadata = JSON.stringify({
    name,
    mimeType: 'application/pdf',
    parents: [parentId],
  })
  const boundary = 'fletcher_export_boundary_3141592'
  const enc = new TextEncoder()
  const metaPart  = enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`)
  const dataPart  = enc.encode(`--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`)
  const endPart   = enc.encode(`\r\n--${boundary}--`)

  const body = new Uint8Array(metaPart.length + dataPart.length + bytes.length + endPart.length)
  let off = 0
  body.set(metaPart,  off); off += metaPart.length
  body.set(dataPart,  off); off += dataPart.length
  body.set(bytes,     off); off += bytes.length
  body.set(endPart,   off)

  const resp = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${getToken()}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  )
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Upload failed (${resp.status}): ${text}`)
  }
  return resp.json()
}

// ── Part resolution ────────────────────────────────────────────────────────
// Mirrors Colab's PopulatePartsFromRaw + PopulateAlternativeParts.
//
// Step 1 — raw matching: for EVERY key in partDefs (including internal parts
//   like 'Lead Sheet C', 'Rhythm Section'), scan the song's parts dict for the
//   first raw name match.  Result = allResolved map used by the alt chain.
//
// Step 2 — alt chain: for each SELECTED part only, if no raw match, walk the
//   alt list and take the first part that has a resolved file ID.
//
// Returns { resolved: {part: fileId}, warnings: [part, …] }

export function resolvePartsForSong(songPartsJson, parts, partDefs) {
  const songParts = typeof songPartsJson === 'string'
    ? JSON.parse(songPartsJson)
    : (songPartsJson || {})

  // Step 1: raw match across ALL partDef keys
  const allResolved = {}
  for (const [partName, def] of Object.entries(partDefs)) {
    for (const rawName of (def.raw || [])) {
      if (rawName.toLowerCase() in songParts) {
        allResolved[partName] = songParts[rawName.toLowerCase()]
        break
      }
    }
  }

  // Step 2: alt chain for selected parts
  const resolved = {}
  const warnings = []
  for (const part of parts) {
    if (allResolved[part]) {
      resolved[part] = allResolved[part]
      continue
    }
    const alts = partDefs[part]?.alt || []
    let found = false
    for (const altPart of alts) {
      if (allResolved[altPart]) {
        resolved[part] = allResolved[altPart]
        found = true
        break
      }
    }
    if (!found) warnings.push(part)
  }

  return { resolved, warnings }
}

// ── Main export function ───────────────────────────────────────────────────

/**
 * Export a gig's setlist to Google Drive.
 *
 * @param {object}   gig             - Row from the gigs table (id, name, setlist, parts, …)
 * @param {function} onProgress      - Callback(message: string) for live log output
 * @param {function} onStageProgress - Callback(stage: string, done: number, total: number) for per-stage progress bars
 * @returns {{ success: boolean, errors: string[] }}
 */
export async function exportGig({ gig, onProgress = () => {}, onStageProgress = () => {} }) {
  const errors = []

  // ── Load settings ──────────────────────────────────────────────────────
  const settingRows = await db.exec(
    `SELECT key, value FROM settings WHERE key IN ('part_definitions','export_folder_name','active_parts')`
  )
  const settings = Object.fromEntries(settingRows.map(r => [r.key, JSON.parse(r.value)]))
  const partDefs         = settings.part_definitions  || {}
  const exportFolderName = settings.export_folder_name || ''
  const activePartsDef   = settings.active_parts       || []

  if (!exportFolderName) throw new Error('Export folder not configured — set it in Settings.')

  // Parts for this gig (fall back to active_parts if not set)
  const parts = gig.parts ? JSON.parse(gig.parts) : activePartsDef

  // ── Flatten setlist across all sets ───────────────────────────────────
  // Setlist is either legacy string[] or [{id, name, song_ids:[]}]
  const rawSetlist = typeof gig.setlist === 'string' ? JSON.parse(gig.setlist) : gig.setlist
  let songIds = []
  if (rawSetlist.length === 0) throw new Error('Setlist is empty.')
  if (typeof rawSetlist[0] === 'string') {
    // Legacy flat format
    songIds = rawSetlist
  } else {
    // Multi-set format — flatten in set order
    for (const set of rawSetlist) songIds = songIds.concat(set.song_ids || [])
  }
  if (songIds.length === 0) throw new Error('Setlist is empty.')

  // ── Load song rows from SQLite ─────────────────────────────────────────
  const placeholders = songIds.map(() => '?').join(',')
  const songRows = await db.exec(
    `SELECT id, title, parts FROM songs WHERE id IN (${placeholders})`,
    songIds
  )
  const songMap = new Map(songRows.map(s => [s.id, s]))

  onProgress(`Exporting "${gig.name}" — ${songIds.length} songs, ${parts.length} parts`)

  // ── Stage progress helpers ────────────────────────────────────────────────
  // Single resetting bar: beginStage() resets to 0 with a new label + total,
  // stageTick() advances it. The UI shows one bar at a time that resets between phases.
  let _stageLabel = '', _stageDone = 0, _stageTotal = 0
  function beginStage(label, total) {
    _stageLabel = label; _stageDone = 0; _stageTotal = total
    onStageProgress(label, 0, total)
  }
  function stageTick() {
    onStageProgress(_stageLabel, ++_stageDone, _stageTotal)
  }
  // Relabel the current stage without resetting the bar
  function updateStageLabel(label) {
    _stageLabel = label
    onStageProgress(label, _stageDone, _stageTotal)
  }

  // ── Build folder structure ─────────────────────────────────────────────
  // export_folder_name may be a slash-separated path, e.g. "Band/Year/Shows".
  // Walk each segment: the first must already exist (no implicit root creation),
  // subsequent segments are created if missing.
  const pathSegments = exportFolderName.split('/').map(s => s.trim()).filter(Boolean)
  if (pathSegments.length === 0) throw new Error('Export folder not configured — set it in Settings.')

  onProgress(`\nLocating export folder "${exportFolderName}"…`)
  // Stage: setting up the folder tree — one tick per folder resolved
  beginStage('Setting up folders', pathSegments.length + 2)  // +2: Setlists + gig folder

  // First segment must exist at the Drive root
  let currentFolder = await findFolder(pathSegments[0], null)
  if (!currentFolder) throw new Error(`Export folder "${pathSegments[0]}" not found in Drive.`)
  onProgress(`  Found: ${pathSegments[0]}`)
  stageTick()

  // Remaining segments are created if missing
  for (const segment of pathSegments.slice(1)) {
    currentFolder = await findOrCreateFolder(segment, currentFolder.id, onProgress)
    stageTick()
  }

  const setlistsFolder = await findOrCreateFolder('Setlists', currentFolder.id, onProgress)
  stageTick()
  const gigFolder = await findOrCreateFolder(gig.name, setlistsFolder.id, onProgress)
  stageTick()

  // Stage: prepare part folders — starts as "Creating part folders", switches to
  // "Clearing old PDFs" the first time we actually find PDFs to delete.
  onProgress('\nPreparing part folders…')
  beginStage('Creating part folders', parts.length)
  const partFolders = {}
  let anyCleared = false
  for (const part of parts) {
    partFolders[part] = await findOrCreateFolder(part, gigFolder.id, onProgress)
    const cleared = await clearPdfsInFolder(partFolders[part].id)
    if (cleared > 0) {
      if (!anyCleared) { anyCleared = true; updateStageLabel('Clearing old PDFs') }
      onProgress(`  Cleared ${cleared} existing PDF(s) from ${part}`)
    }
    stageTick()
  }

  // ── Resolve parts + copy individual PDFs ──────────────────────────────
  // Stage: copying — one tick per song×part slot (including missing files)
  onProgress('\nCopying individual PDFs…')
  beginStage('Copying PDFs', songIds.length * parts.length)
  const resolvedMap = {}

  for (const songId of songIds) {
    const song = songMap.get(songId)
    if (!song) {
      const msg = `⚠ Song ${songId} not in library — skipped`
      onProgress(`  ${msg}`)
      errors.push(msg)
      for (let i = 0; i < parts.length; i++) stageTick()
      continue
    }

    const { resolved, warnings } = resolvePartsForSong(song.parts, parts, partDefs)
    resolvedMap[songId] = resolved

    for (const part of warnings) {
      const msg = `⚠ No ${part} part for "${song.title}"`
      onProgress(`  ${msg}`)
      errors.push(msg)
    }

    onProgress(`  ${song.title}`)
    for (const part of parts) {
      const fileId = resolved[part]
      if (!fileId) { stageTick(); continue }
      const filename = `${songId} - ${song.title} - ${part}.pdf`
      try {
        await copyFile(fileId, filename, partFolders[part].id)
      } catch (err) {
        const msg = `✗ Copy failed: ${part}/"${song.title}": ${err.message}`
        onProgress(`    ${msg}`)
        errors.push(msg)
      }
      stageTick()
    }
  }

  // ── Merge per part ─────────────────────────────────────────────────────
  // Stage per part: "Merging — <part>" — one tick per song fetched + upload
  const mergedPartBytes = {}  // part → Uint8Array (kept in memory for full merge)

  for (const part of parts) {
    // Count songs that actually have a file for this part (used as the total)
    const songsForPart = songIds.filter(id => resolvedMap[id]?.[part])
    beginStage(`Merging — ${part}`, songsForPart.length + 1)  // +1 for the upload tick
    onProgress(`\n  ${part}…`)

    const mergedDoc = await PDFDocument.create()
    let pageCount = 0

    for (const songId of songsForPart) {
      const fileId = resolvedMap[songId][part]
      try {
        const bytes  = await fetchPdfBytes(fileId)
        const srcDoc = await PDFDocument.load(bytes)
        const pages  = await mergedDoc.copyPages(srcDoc, srcDoc.getPageIndices())
        pages.forEach(p => mergedDoc.addPage(p))
        pageCount += pages.length
      } catch (err) {
        const msg = `⚠ Merge skipped ${songId}/${part}: ${err.message}`
        onProgress(`    ${msg}`)
        errors.push(msg)
      }
      stageTick()
    }

    const mergedBytes = await mergedDoc.save()
    mergedPartBytes[part] = mergedBytes

    const mergedName = `ALL - ${gig.name} - ${part}.pdf`
    await uploadPdf(mergedName, mergedBytes, partFolders[part].id)
    onProgress(`    ✓ ${mergedName} (${pageCount} pages)`)
    stageTick()  // upload tick
  }

  // ── Full merge (all parts combined) ───────────────────────────────────
  // Stage: building the combined PDF — one tick per part loaded
  onProgress('\nMerging all parts…')
  beginStage('Building full merge', parts.length)
  const fullDoc = await PDFDocument.create()
  for (const part of parts) {
    const bytes = mergedPartBytes[part]
    if (!bytes) { stageTick(); continue }
    const srcDoc = await PDFDocument.load(bytes)
    const pages  = await fullDoc.copyPages(srcDoc, srcDoc.getPageIndices())
    pages.forEach(p => fullDoc.addPage(p))
    stageTick()
  }
  const fullBytes = await fullDoc.save()
  const fullName  = `ALL PARTS - ${gig.name}.pdf`
  await uploadPdf(fullName, fullBytes, gigFolder.id)
  onProgress(`✓ ${fullName}`)

  onProgress('\n✓ Export complete!')
  return { success: true, errors }
}
