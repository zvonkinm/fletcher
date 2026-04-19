// src/drive/files.js
// Shared Drive download utilities — used by export.js and the PDF viewer.

import { tokenExpiresIn, refreshAccessToken } from '../auth/google.js'

function getToken() {
  // Prefer the token gapi is actively using so raw fetch calls stay in sync.
  return window.gapi?.client?.getToken()?.access_token
    || sessionStorage.getItem('access_token')
}

function driveMediaUrl(fileId) {
  return `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`
}

/**
 * Download a Drive file's binary content as an ArrayBuffer.
 *
 * Handles token expiry transparently:
 *   - If the token is already expired (or expires within 60 s), refreshes
 *     silently before making the request.
 *   - If the request returns 401 (expired mid-session), refreshes and retries
 *     once before giving up.
 * Throws a user-readable Error on failure.
 */
export async function fetchPdfBytes(fileId) {
  // Pre-flight: refresh if the token is about to expire
  if (tokenExpiresIn() < 60_000) {
    await refreshAccessToken()
    // Intentionally continue even if refresh fails — the request may still
    // work if gapi has a valid token internally; we'll catch 401 below.
  }

  async function attempt() {
    return fetch(driveMediaUrl(fileId), {
      headers: { Authorization: `Bearer ${getToken()}` },
    })
  }

  let resp = await attempt()

  // 401 means the token expired between the pre-flight check and now (or the
  // refresh above didn't persist correctly). Try once more after a fresh refresh.
  if (resp.status === 401) {
    const refreshed = await refreshAccessToken()
    if (!refreshed) {
      throw new Error('Session expired — please sign out and sign back in.')
    }
    resp = await attempt()
  }

  if (!resp.ok) throw new Error(`Download failed (${resp.status}) for file ${fileId}`)
  return resp.arrayBuffer()
}
