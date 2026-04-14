// src/auth/google.js
// Handles Google Identity Services (GSI) sign-in and gapi Drive client init.

export const CLIENT_ID =
  '1089043244006-h9kskqft3tn80j49m2fgl2d5j19rgvrm.apps.googleusercontent.com'

export const SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
].join(' ')

const DISCOVERY_DOC =
  'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest'

// ── Internal state ────────────────────────────────────────────────────────

let _tokenClient = null
let _accessToken = null
let _gapiReady = false

// ── Helpers ───────────────────────────────────────────────────────────────

/** Wait for a global to appear (gapi / google are loaded async). */
function waitForGlobal(name, timeout = 10_000) {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const check = () => {
      if (window[name]) return resolve(window[name])
      if (Date.now() - start > timeout)
        return reject(new Error(`Timed out waiting for window.${name}`))
      setTimeout(check, 100)
    }
    check()
  })
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Initialise the gapi client with the Drive discovery doc.
 * Safe to call multiple times — resolves immediately if already ready.
 */
export async function initGapi() {
  if (_gapiReady) return
  await waitForGlobal('gapi')
  await new Promise((resolve) => window.gapi.load('client', resolve))
  await window.gapi.client.init({ discoveryDocs: [DISCOVERY_DOC] })
  _gapiReady = true
}

/**
 * Initialise the GSI token client.
 * Must be called once before requestToken().
 */
export async function initGsi() {
  await waitForGlobal('google')
  _tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: () => {}, // overridden per-request in requestToken()
  })
}

/**
 * Request an access token interactively (shows Google consent popup).
 * Resolves with the token response object.
 */
export function requestToken() {
  return new Promise((resolve, reject) => {
    if (!_tokenClient) {
      return reject(new Error('GSI not initialised — call initGsi() first'))
    }
    _tokenClient.callback = (response) => {
      if (response.error) return reject(new Error(response.error))
      _accessToken = response.access_token
      // Attach token to gapi so Drive calls are authenticated
      window.gapi.client.setToken({ access_token: _accessToken })
      resolve(response)
    }
    // prompt: '' reuses existing session silently; 'consent' forces the picker
    _tokenClient.requestAccessToken({ prompt: _accessToken ? '' : 'consent' })
  })
}

/**
 * Sign the user out and clear the stored token.
 */
export function signOut() {
  if (_accessToken) {
    window.google.accounts.oauth2.revoke(_accessToken)
    _accessToken = null
  }
  window.gapi.client.setToken(null)
}

/** Returns true if we currently have an access token. */
export function isSignedIn() {
  return !!_accessToken
}
