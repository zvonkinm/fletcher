// src/auth/google.js
// Google OAuth 2.0 — PKCE authorization code flow using a Desktop app client.
//
// Desktop app OAuth client with PKCE + Cloudflare Worker for token exchange.
// The client secret lives only in Cloudflare environment variables —
// never in browser code or the GitHub repo.
//
// Flow:
//   1. triggerSignIn() generates a PKCE challenge and redirects to Google
//   2. Google redirects back to /fletcher/?code=...
//   3. handleRedirectCallback() exchanges the code + verifier for a token

export const CLIENT_ID =
  '1089043244006-h9kskqft3tn80j49m2fgl2d5j19rgvrm.apps.googleusercontent.com'

// Token exchange is handled by a Cloudflare Worker — the client secret
// never appears in browser code or the GitHub repo.
const AUTH_WORKER_URL = 'https://fletcher-auth-worker.zvonkinm.workers.dev/token'

export const SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
].join(' ')

const DISCOVERY_DOC =
  'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest'

const REDIRECT_URI = window.location.origin + '/fletcher/'

// ── Internal state ─────────────────────────────────────────────────────────
let _accessToken = null
let _gapiReady = false

// ── Helpers ────────────────────────────────────────────────────────────────

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return }
    const s = document.createElement('script')
    s.src = src
    s.onload = resolve
    s.onerror = () => reject(new Error(`Failed to load: ${src}`))
    document.head.appendChild(s)
  })
}

function waitForGlobal(name, timeout = 10_000) {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const check = () => {
      if (window[name]) return resolve()
      if (Date.now() - start > timeout)
        return reject(new Error(`Timed out waiting for ${name}`))
      setTimeout(check, 100)
    }
    check()
  })
}

// PKCE — generates a random verifier and its SHA-256 challenge
async function generatePKCE() {
  const verifier = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(b => b.toString(16).padStart(2, '0')).join('')
  const encoded = new TextEncoder().encode(verifier)
  const digest = await crypto.subtle.digest('SHA-256', encoded)
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
  return { verifier, challenge }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Minimal init — just loads the GSI script so gapi can use it later.
 */
export async function initGsi() {
  await loadScript('https://accounts.google.com/gsi/client')
  await waitForGlobal('google')
  console.log('[auth] GSI ready')
}

/**
 * Check if Google redirected back with an auth code in the URL.
 * Call on every app load. Returns true if a token was successfully obtained.
 */
export async function handleRedirectCallback() {
  const params = new URLSearchParams(window.location.search)
  const code = params.get('code')
  const returnedState = params.get('state')

  if (!code) return false

  // Validate state to prevent CSRF attacks
  const storedState = sessionStorage.getItem('oauth_state')
  const verifier = sessionStorage.getItem('pkce_verifier')

  // Clean URL and storage immediately
  history.replaceState({}, '', window.location.pathname)
  sessionStorage.removeItem('oauth_state')
  sessionStorage.removeItem('pkce_verifier')

  if (returnedState !== storedState) {
    console.error('[auth] State mismatch — ignoring redirect')
    return false
  }

  if (!verifier) {
    console.error('[auth] No PKCE verifier found')
    return false
  }

  console.log('[auth] Exchanging code for token via Cloudflare Worker...')

  // Call our Cloudflare Worker — it holds the client secret server-side
  const response = await fetch(AUTH_WORKER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    }),
  })

  const data = await response.json()

  if (data.error) {
    console.error('[auth] Token exchange failed:', data.error, data.error_description)
    return false
  }

  _accessToken = data.access_token
  const expiresAt = Date.now() + (parseInt(data.expires_in || '3600') * 1000)
  sessionStorage.setItem('access_token', _accessToken)
  sessionStorage.setItem('token_expires_at', String(expiresAt))

  // Store refresh token if provided (Desktop clients can return one)
  if (data.refresh_token) {
    sessionStorage.setItem('refresh_token', data.refresh_token)
  }

  console.log('[auth] Token obtained via PKCE')
  return true
}

/**
 * Try to restore a valid token from sessionStorage.
 * Returns true if a non-expired token was found.
 */
export function restoreSession() {
  const token = sessionStorage.getItem('access_token')
  const expiresAt = parseInt(sessionStorage.getItem('token_expires_at') || '0')
  if (token && Date.now() < expiresAt - 60_000) {
    _accessToken = token
    console.log('[auth] Session restored from storage')
    return true
  }
  sessionStorage.removeItem('access_token')
  sessionStorage.removeItem('token_expires_at')
  return false
}

/**
 * Redirect to Google sign-in using PKCE authorization code flow.
 * Page navigates away — nothing after this call runs.
 */
export async function triggerSignIn() {
  const { verifier, challenge } = await generatePKCE()
  const state = crypto.randomUUID()

  sessionStorage.setItem('pkce_verifier', verifier)
  sessionStorage.setItem('oauth_state', state)

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    access_type: 'offline',   // request refresh token
    prompt: 'select_account',
  })

  console.log('[auth] Redirecting to Google (PKCE)...')
  window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`
}

/**
 * Load gapi and initialise the Drive client with the current token.
 */
export async function initGapi() {
  if (_gapiReady) return
  await loadScript('https://apis.google.com/js/api.js')
  await waitForGlobal('gapi')
  await new Promise((resolve) => window.gapi.load('client', resolve))
  await window.gapi.client.init({ discoveryDocs: [DISCOVERY_DOC] })
  window.gapi.client.setToken({ access_token: _accessToken })
  _gapiReady = true
  console.log('[auth] gapi ready')
}

/**
 * Sign out — clear all tokens and state.
 */
export function signOut() {
  _accessToken = null
  _gapiReady = false
  sessionStorage.removeItem('access_token')
  sessionStorage.removeItem('token_expires_at')
  sessionStorage.removeItem('refresh_token')
  sessionStorage.removeItem('oauth_state')
  sessionStorage.removeItem('pkce_verifier')
  if (window.gapi?.client) window.gapi.client.setToken(null)
  console.log('[auth] Signed out')
}

/** Returns true if we currently have a valid access token. */
export function isSignedIn() {
  return !!_accessToken
}

/**
 * Returns milliseconds until the current access token expires.
 * Returns 0 if the token is already expired or absent.
 */
export function tokenExpiresIn() {
  const expiresAt = parseInt(sessionStorage.getItem('token_expires_at') || '0')
  return Math.max(0, expiresAt - Date.now())
}

/**
 * Try to exchange the stored refresh token for a fresh access token.
 * The Cloudflare Worker must handle { grant_type: 'refresh_token', refresh_token }.
 * Returns true on success, false if no refresh token is available or the request fails.
 */
export async function refreshAccessToken() {
  const refreshToken = sessionStorage.getItem('refresh_token')
  if (!refreshToken) {
    console.warn('[auth] No refresh token stored — cannot refresh silently')
    return false
  }

  try {
    const response = await fetch(AUTH_WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type:    'refresh_token',
        refresh_token: refreshToken,
      }),
    })
    const data = await response.json()

    if (data.error) {
      console.error('[auth] Refresh failed:', data.error, data.error_description)
      return false
    }

    _accessToken = data.access_token
    const expiresAt = Date.now() + (parseInt(data.expires_in || '3600') * 1000)
    sessionStorage.setItem('access_token', _accessToken)
    sessionStorage.setItem('token_expires_at', String(expiresAt))
    // Google may rotate the refresh token on each use
    if (data.refresh_token) {
      sessionStorage.setItem('refresh_token', data.refresh_token)
    }

    // Keep gapi in sync with the new token
    if (window.gapi?.client) {
      window.gapi.client.setToken({ access_token: _accessToken })
    }

    console.log('[auth] Token refreshed silently')
    return true
  } catch (err) {
    console.error('[auth] Refresh request failed:', err)
    return false
  }
}
