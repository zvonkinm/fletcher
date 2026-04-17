// src/components/NavBar.jsx
import React from 'react'
import { NavLink } from 'react-router-dom'
import styles from './NavBar.module.css'
import logoUrl from '../assets/logo.js'

export default function NavBar({ onSignOut }) {
  return (
    <nav className={styles.nav}>
      <span className={styles.brand}>
        <img src={logoUrl} alt="" className={styles.brandLogo} aria-hidden="true" />
        Fletcher
      </span>

      <div className={styles.links}>
        {/* NavLink automatically adds an "active" class when the route matches.
            We use a function to apply our own CSS module class instead. */}
        <NavLink
          to="/repertoire"
          className={({ isActive }) =>
            isActive ? `${styles.link} ${styles.linkActive}` : styles.link
          }
          end
        >
          Repertoire
        </NavLink>
        <NavLink
          to="/gigs"
          className={({ isActive }) =>
            isActive ? `${styles.link} ${styles.linkActive}` : styles.link
          }
        >
          Gigs
        </NavLink>
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            isActive ? `${styles.link} ${styles.linkActive}` : styles.link
          }
        >
          Settings
        </NavLink>
      </div>

      <button className={styles.signOut} onClick={onSignOut}>
        Sign out
      </button>
    </nav>
  )
}
