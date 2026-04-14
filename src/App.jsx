// src/App.jsx
import React, { useEffect, useState } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { initGapi, initGsi, requestToken, signOut, isSignedIn } from './auth/google.js'
import { db } from './db/index.js'
import NavBar from './components/NavBar.jsx'
import Repertoire from './views/Repertoire.jsx'
import Setlist from './views/Setlist.jsx'
import Settings from './views/Settings.jsx'

export default function App() {
  const [authState, setAuthState] = useState('idle')   // idle | signing-in | signed-in | error
  const [dbReady, setDbReady] = useState(false)
  const [error, setError] = useState(null)

  // ── Initialise DB ────────────────────────────────────────────────────────
  useEffect(() => {
    db.ready
      .then(() => setDbReady(true))
      .catch((err) => {
        console.error('[App] DB init failed:', err)
        setError(`Database failed to initialise: ${err.message}`)
      })
  }, [])

  // ── Initialise Google clients ─────────────────────────────────────────────
  useEffect(() => {
    Promise.all([initGapi(), initGsi()])
      .then(() => {
        // If we already have a token from this session, skip the sign-in screen
        if (isSignedIn()) setAuthState('signed-in')
      })
      .catch((err) => {
        console.error('[App] Google init failed:', err)
        setError(`Google API failed to load: ${err.message}`)
      })
  }, [])

  async function handleSignIn() {
    setAuthState('signing-in')
    try {
      await requestToken()
      setAuthState('signed-in')
    } catch (err) {
      console.error('[App] Sign-in failed:', err)
      setAuthState('error')
      setError(`Sign-in failed: ${err.message}`)
    }
  }

  function handleSignOut() {
    signOut()
    setAuthState('idle')
  }

  // ── Error state ───────────────────────────────────────────────────────────
  if (error) {
    return (
      <div style={styles.center}>
        <div style={styles.errorCard}>
          <h2 style={{ color: '#C0392B', marginTop: 0 }}>Something went wrong</h2>
          <p style={{ fontFamily: 'monospace', fontSize: 13 }}>{error}</p>
          <button style={styles.btn} onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    )
  }

  // ── Loading state ─────────────────────────────────────────────────────────
  if (!dbReady) {
    return (
      <div style={styles.center}>
        <p style={{ color: '#4A5568', fontFamily: 'Arial, sans-serif' }}>
          Initialising database…
        </p>
      </div>
    )
  }

  // ── Sign-in screen ────────────────────────────────────────────────────────
  if (authState !== 'signed-in') {
    return (
      <div style={styles.center}>
        <div style={styles.loginCard}>
          <h1 style={styles.logo}>Fletcher</h1>
          <p style={styles.subtitle}>Vintage Ties Band Manager</p>
          <button
            style={{ ...styles.btn, opacity: authState === 'signing-in' ? 0.6 : 1 }}
            disabled={authState === 'signing-in'}
            onClick={handleSignIn}
          >
            {authState === 'signing-in' ? 'Signing in…' : 'Sign in with Google'}
          </button>
        </div>
      </div>
    )
  }

  // ── Main app ──────────────────────────────────────────────────────────────
  return (
    <div style={styles.app}>
      <NavBar onSignOut={handleSignOut} />
      <main style={styles.main}>
        <Routes>
          <Route path="/" element={<Navigate to="/repertoire" replace />} />
          <Route path="/repertoire" element={<Repertoire />} />
          <Route path="/setlist/:gigId?" element={<Setlist />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  )
}

// ── Inline styles (minimal — real styling comes in Step 2) ─────────────────
const styles = {
  app: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    fontFamily: 'Arial, sans-serif',
    background: '#F7F9FC',
  },
  main: {
    flex: 1,
    overflow: 'auto',
    padding: '24px',
  },
  center: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100vh',
    background: '#F7F9FC',
    fontFamily: 'Arial, sans-serif',
  },
  loginCard: {
    background: '#fff',
    borderRadius: 12,
    padding: '48px 56px',
    boxShadow: '0 4px 24px rgba(27,43,75,0.12)',
    textAlign: 'center',
    minWidth: 320,
  },
  errorCard: {
    background: '#fff',
    borderRadius: 12,
    padding: '32px 40px',
    boxShadow: '0 4px 24px rgba(192,57,43,0.12)',
    maxWidth: 480,
  },
  logo: {
    fontSize: 40,
    fontWeight: 700,
    color: '#1B2B4B',
    margin: '0 0 8px',
    letterSpacing: '-1px',
  },
  subtitle: {
    color: '#C9A84C',
    fontWeight: 600,
    marginBottom: 32,
    fontSize: 14,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
  },
  btn: {
    background: '#1B2B4B',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    padding: '12px 28px',
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'Arial, sans-serif',
  },
}
