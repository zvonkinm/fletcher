// src/drive/files.js
// Shared Drive download utilities — used by export.js and the PDF viewer.

function getToken() {
  // Prefer the token gapi is actively using so raw fetch calls stay in sync.
  return window.gapi?.client?.getToken()?.access_token
    || sessionStorage.getItem('access_token')
}

/**
 * Download a Drive file's binary content as an ArrayBuffer.
 * Uses the authenticated user's token — works for any file they have access to.
 */
export async function fetchPdfBytes(fileId) {
  const resp = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${getToken()}` } }
  )
  if (!resp.ok) throw new Error(`Download failed (${resp.status}) for file ${fileId}`)
  return resp.arrayBuffer()
}
