// src/App.jsx
import React, { useEffect, useState } from 'react'
import { Routes, Route, Navigate, Link } from 'react-router-dom'
import { initGsi, initGapi, triggerSignIn, signOut, isSignedIn,
         handleRedirectCallback, restoreSession } from './auth/google.js'
import { db } from './db/index.js'
import { loadSettingsFromDrive, loadGigsFromDrive, loadMusiciansFromDrive, isRootFolderConfigured } from './drive/sync-gigs.js'
import NavBar from './components/NavBar.jsx'
import Repertoire from './views/Repertoire.jsx'
import Gigs from './views/Gigs.jsx'
import Personnel from './views/Personnel.jsx'
import Settings from './views/Settings.jsx'
import styles from './App.module.css'
import logoUrl from './assets/logo.js'

// Initialise GSI once at module level — outside the React component so that
// React StrictMode's double-invocation doesn't create two token clients.
const gsiReady = initGsi()

// Guard against React StrictMode's double-invocation of useEffect.
// Module-level variables are true singletons per page load (reset on F5),
// so this flag prevents a second concurrent initAuth() run in development
// without affecting production or normal navigation.
let authInitStarted = false

export default function App() {
  // authState drives which screen is shown:
  //   'loading'   — checking for an existing session (shown on every page load)
  //   'idle'      — no session found, show sign-in screen
  //   'signed-in' — token available, show main app
  //   'error'     — unrecoverable error, show error card
  const [authState, setAuthState]         = useState('loading')
  const [dbReady, setDbReady]             = useState(false)
  const [error, setError]                 = useState(null)
  // rootFolderValid: false when the configured root Drive folder wasn't found
  // during sign-in.  Gigs and musicians are NOT synced in that case to prevent
  // local (seeded) data from overwriting real Drive data when the user later
  // fixes the folder path in Settings.
  const [rootFolderValid, setRootFolderValid] = useState(true)

  // ── Initialise SQLite DB ───────────────────────────────────────────────
  useEffect(() => {
    db.ready
      .then(() => setDbReady(true))
      .catch((err) => {
        console.error('[App] DB init failed:', err)
        setError(`Database failed to initialise: ${err.message}`)
      })
  }, [])

  // ── Auth init — handle redirect or restore session ─────────────────────
  useEffect(() => {
    // StrictMode mounts effects twice; the module-level flag ensures only the
    // first invocation proceeds so Drive sync functions aren't called concurrently.
    if (authInitStarted) return
    authInitStarted = true

    // Load gigs and musicians from Drive, but only if the configured root
    // folder actually exists in Drive.  If it doesn't, we skip sync entirely
    // so that seeded / stale local data can never overwrite real Drive data
    // when the user later corrects the folder path in Settings.
    async function syncGigsAndMusicians() {
      const valid = await isRootFolderConfigured()
      if (!valid) {
        setRootFolderValid(false)
        console.warn('[App] Root Drive folder not found — gig/musician sync skipped')
        return
      }
      await loadGigsFromDrive()       // non-fatal on failure
      await loadMusiciansFromDrive()  // non-fatal on failure
    }

    async function initAuth() {
      await gsiReady  // wait for GSI script to load

      // Case 1: returning from Google's sign-in redirect (?code=... in URL)
      const fromRedirect = await handleRedirectCallback()
      if (fromRedirect) {
        await initGapi()
        await loadSettingsFromDrive()   // restore persisted settings (export path, etc.)
        await syncGigsAndMusicians()
        setAuthState('signed-in')
        return
      }

      // Case 2: valid token already in sessionStorage from this browser session
      if (restoreSession()) {
        await initGapi()
        await loadSettingsFromDrive()   // restore persisted settings (export path, etc.)
        await syncGigsAndMusicians()
        setAuthState('signed-in')
        return
      }

      // Case 3: no token — show the sign-in screen
      setAuthState('idle')
    }

    initAuth().catch((err) => {
      console.error('[App] Auth init failed:', err)
      setAuthState('idle') // degrade gracefully to sign-in rather than hard error
    })
  }, [])

  // ── Sign-in handler ────────────────────────────────────────────────────
  async function handleSignIn() {
    try {
      // triggerSignIn() generates a PKCE challenge then redirects the page
      // to Google. Nothing after this call runs — the browser navigates away.
      await triggerSignIn()
    } catch (err) {
      console.error('[App] Sign-in redirect failed:', err)
      setError(`Sign-in failed: ${err.message}`)
    }
  }

  // ── Sign-out handler ───────────────────────────────────────────────────
  function handleSignOut() {
    signOut()             // clears token from memory and sessionStorage
    setAuthState('idle')  // return to sign-in screen
  }

  // ── Error screen ───────────────────────────────────────────────────────
  if (error) {
    return (
      <div className={styles.center}>
        <div className={styles.errorCard}>
          <h2 className={styles.errorHeading}>Something went wrong</h2>
          <p className={styles.errorMessage}>{error}</p>
          <button className={styles.btn} onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    )
  }

  // ── Loading screen (DB init or auth check in progress) ────────────────
  if (authState === 'loading' || !dbReady) {
    return (
      <div className={styles.center}>
        <p className={styles.loadingText}>
          {!dbReady ? 'Initialising database…' : 'Checking session…'}
        </p>
      </div>
    )
  }

  // ── Sign-in screen ─────────────────────────────────────────────────────
  if (authState !== 'signed-in') {
    return (
      <div className={styles.center}>
        <div className={styles.loginCard}>
          <img src={logoUrl} alt="Fletcher Henderson portrait" className={styles.logoMark} />
          <h1 className={styles.logo}>Fletcher</h1>
          <p className={styles.subtitle}>Band Manager</p>
          <button className={styles.btn} onClick={handleSignIn}>
            Sign in with Google
          </button>
        </div>
      </div>
    )
  }

  // ── Main app shell ─────────────────────────────────────────────────────
  return (
    <div className={styles.app}>
      <NavBar onSignOut={handleSignOut} />
      {/* Shown when the configured root Drive folder wasn't found at sign-in.
          Gigs and musicians were NOT synced from Drive in this state — the user
          must set the correct folder path in Settings before sync runs. */}
      {!rootFolderValid && (
        <div className={styles.rootFolderWarning}>
          <span>
            Root Drive folder not found. Go to{' '}
            <Link to="/settings" className={styles.rootFolderWarningLink}>Settings</Link>
            {' '}to set the correct folder path — gigs and musicians have not been synced yet.
          </span>
        </div>
      )}
      <main className={styles.main}>
        <Routes>
          {/* Default route redirects to Gigs */}
          <Route path="/" element={<Navigate to="/gigs" replace />} />
          <Route path="/repertoire" element={<Repertoire />} />
          <Route path="/gigs/:gigId?" element={<Gigs />} />
          <Route path="/personnel" element={<Personnel />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  )
}
