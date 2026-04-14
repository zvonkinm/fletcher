// src/components/NavBar.jsx
import React from 'react'
import { NavLink } from 'react-router-dom'

export default function NavBar({ onSignOut }) {
  return (
    <nav style={styles.nav}>
      <span style={styles.brand}>Fletcher</span>
      <div style={styles.links}>
        <NavLink to="/repertoire" style={navStyle} end>
          Repertoire
        </NavLink>
        <NavLink to="/setlist" style={navStyle}>
          Setlists
        </NavLink>
        <NavLink to="/settings" style={navStyle}>
          Settings
        </NavLink>
      </div>
      <button style={styles.signOut} onClick={onSignOut}>
        Sign out
      </button>
    </nav>
  )
}

function navStyle({ isActive }) {
  return {
    ...styles.link,
    borderBottom: isActive ? '2px solid #C9A84C' : '2px solid transparent',
    color: isActive ? '#1B2B4B' : '#4A5568',
  }
}

const styles = {
  nav: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '0 24px',
    height: 56,
    background: '#fff',
    borderBottom: '1px solid #D0D9E8',
    boxShadow: '0 1px 4px rgba(27,43,75,0.06)',
  },
  brand: {
    fontWeight: 700,
    fontSize: 20,
    color: '#1B2B4B',
    letterSpacing: '-0.5px',
    marginRight: 24,
  },
  links: {
    display: 'flex',
    gap: 4,
    flex: 1,
  },
  link: {
    padding: '0 16px',
    height: 56,
    display: 'flex',
    alignItems: 'center',
    textDecoration: 'none',
    fontWeight: 600,
    fontSize: 14,
    fontFamily: 'Arial, sans-serif',
    transition: 'color 0.15s',
  },
  signOut: {
    background: 'none',
    border: '1px solid #D0D9E8',
    borderRadius: 6,
    padding: '6px 14px',
    fontSize: 13,
    color: '#4A5568',
    cursor: 'pointer',
    fontFamily: 'Arial, sans-serif',
  },
}
