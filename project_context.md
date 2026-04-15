# Fletcher — Project Context & History
> This file is intended for use with Claude Code (VS Code extension).
> It provides full project context so Claude can pick up where the previous session left off.

---

## What is Fletcher?

Fletcher is a personal browser-based web app for managing a jazz band (The Vintage Ties).
It replaces a Google Colab Python notebook (`VT_Book_Manager.ipynb`) and a manual spreadsheet.

**Owner:** Bandleader (single-user app — `zvonkinm@gmail.com`)
**Live URL:** https://zvonkinm.github.io/fletcher
**Repo:** https://github.com/zvonkinm/fletcher

---

## Tech Stack (finalised)

| Layer | Choice | Notes |
|---|---|---|
| Frontend | React + Vite | Deployed as static site to GitHub Pages |
| Storage | SQLite WASM (`@sqlite.org/sqlite-wasm`) + OPFS | Runs entirely in browser, persists across sessions |
| Auth | Google Identity Services (GSI) + PKCE | Redirect flow, no popup |
| Auth backend | Cloudflare Worker | Handles token exchange with client secret server-side |
| Drive API | `gapi` JS client (Drive API v3) | Loaded dynamically after auth |
| PDF merge | `pdf-lib` | Phase 1, not yet implemented |
| Drag-and-drop | `dnd-kit` | Implemented in Step 3 (Setlist Builder) |
| Deploy | GitHub Pages | Auto-deploys via GitHub Actions on push to `main` |
| Styling | CSS Modules (`.module.css` per component) | Converted from inline styles in Step 2 |

---

## Google Cloud Setup

- **Project:** Fletcher
- **OAuth client (Web):** `1089043244006-h9kskqft3tn80j49m2fgl2d5j19rgvrm.apps.googleusercontent.com`
  - Used for: Authorised JavaScript origins only
  - Authorised origins: `http://localhost:5173`, `https://zvonkinm.github.io`
- **OAuth client (Desktop — PKCE):** `1089043244006-3lm74io6nubokgkpv94uqg0kavo9s1ad.apps.googleusercontent.com`
  - Used for: actual auth flow (PKCE code exchange via Cloudflare Worker)
- **Drive API:** enabled
- **OAuth scopes:** `drive.readonly` (song library sync) + `drive.file` (PDF upload)
- **Test users:** `zvonkinm@gmail.com`

---

## Cloudflare Worker

- **Name:** `fletcher-auth-worker`
- **URL:** `https://fletcher-auth-worker.zvonkinm.workers.dev/token`
- **Purpose:** Exchanges OAuth auth code + PKCE verifier for access token.
  The client secret lives only in Cloudflare environment variables — never in source code.
- **Secrets stored in Cloudflare:**
  - `GOOGLE_CLIENT_ID` — the Desktop app client ID above
  - `GOOGLE_CLIENT_SECRET` — stored in Cloudflare only, not in repo
- **Location:** separate repo/folder `fletcher-auth-worker/` (not inside the main `fletcher/` repo)
- **Files:**
  - `src/index.js` — the worker code
  - `wrangler.toml` — Cloudflare config
  - `package.json`

---

## Project Structure

```
fletcher/
├── .github/
│   └── workflows/
│       └── deploy.yml          # GitHub Actions: build + deploy to Pages on push to main
├── public/
│   └── _headers                # COOP/COEP headers (for OPFS/SharedArrayBuffer)
├── src/
│   ├── App.jsx                 # Root component: auth gate + router
│   ├── App.module.css
│   ├── index.css               # Global reset
│   ├── main.jsx                # React entry point
│   ├── auth/
│   │   └── google.js           # GSI init, PKCE redirect flow, token management
│   ├── components/
│   │   ├── NavBar.jsx
│   │   └── NavBar.module.css
│   ├── config/
│   │   └── seed.js             # First-run seed: type map, part definitions, 5 historical gigs
│   ├── db/
│   │   ├── index.js            # Main-thread DB façade (promisified worker calls)
│   │   ├── schema.js           # CREATE TABLE statements (songs, gigs, settings)
│   │   └── worker.js           # SQLite WASM Web Worker
│   ├── drive/
│   │   └── sync.js             # Drive sync engine
│   └── views/
│       ├── Repertoire.jsx      # Song library view (search, filter, sync, detail panel)
│       ├── Repertoire.module.css
│       ├── Setlist.jsx         # Setlist builder: gig list, editor, multi-set Kanban
│       ├── Setlist.module.css
│       └── Settings.jsx        # STUB — Step 5
├── index.html
├── package.json
├── vite.config.js              # base: '/fletcher/', COOP/COEP headers, sqlite-wasm exclude
├── BUGS.md                     # Open bug tracker
└── README.md
```

---

## Data Model

### songs table
| Field | Type | Notes |
|---|---|---|
| id | TEXT PK | e.g. `"1023"`, `"1023#Am"` |
| idx | TEXT | 4-digit index e.g. `"1023"` |
| key_variant | TEXT NULL | e.g. `"Am"`, `"Eb"` — null for base version |
| title | TEXT | Apostrophes restored (underscores in Drive → `'` in DB) |
| song_type | TEXT | `Arrangements` / `Instrumentals` / `Lead Sheet` |
| subtype | TEXT | `Swing` / `12 Bar` / `Bluesy` |
| drive_folder_id | TEXT | Google Drive folder ID |
| parts | TEXT | JSON: `{ "vocals": "fileId", "clarinet in bb": "fileId", ... }` |
| blacklisted | INTEGER | 0/1 |
| active | INTEGER | 0/1 — set to 0 if folder disappears from Drive |
| last_synced | INTEGER | Unix timestamp ms |

### gigs table
| Field | Type | Notes |
|---|---|---|
| id | TEXT PK | Slug e.g. `"vtjb_highball_042026"` |
| name | TEXT | Human-readable name |
| date | TEXT NULL | ISO 8601 |
| venue | TEXT NULL | |
| notes | TEXT NULL | |
| band_name | TEXT NULL | e.g. "VTJB", "VTQ" |
| time | TEXT NULL | e.g. "19:30" |
| locked | INTEGER | 0=editable, 1=read-only; seed gigs and pre-migration gigs start locked |
| setlist | TEXT | JSON: string[] (legacy flat) or `{id, name, song_ids[]}[]` (multi-set) |
| print_sublists | TEXT | JSON array of `{name, song_ids[]}` — reserved for V2 |

### settings table
Key/value store. Seeded keys:
- `type_map` — prefix → type/subtype lookup
- `part_definitions` — instrument seats with raw names and alt chains
- `blacklist` — indexes to exclude (default: `["ZZZZ", "1020"]`)
- `active_seats` — ordered list of seats to print
- `master_folder_name` — `"The Vintage Ties 2021"`
- `last_synced` — timestamp of last Drive sync
- `seeded` — `true` after first run

---

## Google Drive Structure

```
The Vintage Ties 2021/          ← master folder (shared with zvonkinm@gmail.com)
  1014 There ain_t no sweet man/
    1014 - There ain't no sweet man - Vocals.pdf
    1014 - There ain't no sweet man - Clarinet.pdf
    ...
  1023#Am No Moon At All/       ← key variant — separate folder
    ...
  3015#Eb Ain_t Misbehavin/
    ...
```

**Naming conventions:**
- Folder: `<4-digit-index>[#<KeyVariant>] <Title>`
- PDF: `<index> - <Title> - <Part>.pdf`
- Underscores in folder names = apostrophes (Drive naming limitation) — restored during sync

**PDF output location:**
```
The Vintage Ties 2021/Setlists/<gig name>/<instrument>/
```

---

## Auth Flow (PKCE + Cloudflare Worker)

```
1. User clicks "Sign in with Google"
2. App generates PKCE challenge (verifier + SHA-256 hash)
3. App stores verifier in sessionStorage, redirects to Google auth URL
4. User signs in at accounts.google.com
5. Google redirects back to /fletcher/?code=...&state=...
6. App validates state, sends code + verifier to Cloudflare Worker
7. Worker exchanges code + secret with Google, returns access_token
8. App stores token in sessionStorage, initialises gapi Drive client
9. App renders main view
```

Token persists for the browser session. On reload, `restoreSession()` checks
sessionStorage and skips the sign-in screen if the token is still valid.

---

## Type / Subtype Map

| Index prefix | Type | Subtype | Badge colour |
|---|---|---|---|
| 10 | Arrangements | Swing | Dark green |
| 11 | Arrangements | 12 Bar | Dark blue |
| 12 | Arrangements | Bluesy | Light blue |
| 20 | Instrumentals | Swing | Amber |
| 21 | Instrumentals | 12 Bar | Purple |
| 30 | Lead Sheet | Swing | Red |
| 31 | Lead Sheet | 12 Bar | Light red |
| 32 | Lead Sheet | Bluesy | Mauve |

---

## Part Resolution Logic

For each song × instrument seat, find the best PDF:

1. **Raw match** — scan song's parts dict for any key matching the seat's raw name list (case-insensitive)
2. **Alt chain walk** — try each alt seat in order; use its already-resolved file ID if available
3. **Unresolvable** — log warning

### Instrument Seats

| Seat | Raw names | Alt chain |
|---|---|---|
| Vocals | voice, vocals, piano | Full Score → Lead Sheet C → Rhythm Section → Rhythm Guitar |
| Clarinet | clarinet, clarinet in bb | Lead Sheet Bb → Tenor Saxophone |
| Tenor Saxophone | tenor saxophone | Clarinet → Lead Sheet Bb |
| Electric Guitar | jazz guitar, electric guitar | Lead Sheet C → Vocals → Rhythm Section |
| Rhythm Guitar | rhythm guitar | Rhythm Section → Lead Sheet C → Vocals → Acoustic Guitar |
| Bass | upright bass, string bass, rhythm section | Rhythm Section → Lead Sheet C → Vocals |
| Drums | drum set, rhythm section | Rhythm Section → Lead Sheet C → Vocals |
| Trumpet | trumpet bb, trumpet in bb | Clarinet → Lead Sheet Bb → Tenor Saxophone |
| Concert *(internal)* | concert | Electric Guitar → Lead Sheet C |
| Bb instrument *(internal)* | bb instrument | Clarinet → Lead Sheet Bb |
| Lead Sheet C *(internal)* | concert, lead sheet | — |
| Lead Sheet Bb *(internal)* | bb instrument, bb instruments | — |
| Rhythm Section *(internal)* | rhythm section | — |

---

## Seed Data — 5 Historical Gigs

| ID | Date | Songs |
|---|---|---|
| `vtjb_highball_042026` | Apr 2026 | 1025, 1014, 3035, 1013, 3023, 2015, 1105, 1026, 1029, 3036, 1018, 2011, 3034, 1017, 1005, 2007, 1023#Am |
| `vtq_batch_0426` | Apr 2026 | 2004, 3037, 2017, 3009, 2012, 3023, 2102, 3029, 3005, 2010, 2103, 3031, 2011, 3016, 2009, 3015#Eb, 2001, 3010, 3028, 2101, 3018, 3034, 2003 |
| `vtjb_highball_0326` | Mar 2026 | 1001, 3031, 1102, 1005, 1105, 2015, 1025, 1023#Am, 1029, 1008, 1018, 1030, 1013, 2005, 1017, 1024, 3025 |
| `vtq_batch_0326` | Mar 2026 | 2004, 3031, 2017, 3037, 2012, 3032, 2102, 1027, 2016, 2104, 3039, 2011, 3016, 2009, 3015#Eb, 2018, 2007, 3010, 2010, 3028, 3045, 2003 |
| `vt_highball_02082026` | Feb 2026 | 1001, 3031, 1102, 1025, 2005, 1017, 2010, 1005, 1023#Am, 1008, 2015, 3023, 1013, 3041, 1026, 1103#Bb, 3025 |

---

## Build Order / Progress

### ✅ Step 1 — Scaffold (COMPLETE)
- React + Vite project
- SQLite WASM + OPFS worker setup
- Google Identity Services auth (PKCE redirect flow)
- Cloudflare Worker for token exchange
- GitHub Pages deploy workflow
- Routing skeleton (Repertoire / Setlist / Settings)
- Seed data loader (config + 5 gigs on first run)
- CSS Modules structure established

### ✅ Step 2 — Song Library (COMPLETE)
- Drive sync engine (`src/drive/sync.js`)
  - Finds master folder by name
  - Parses folder names (index, key variant, title)
  - Restores apostrophes from underscores in titles
  - Builds parts dict (lowercase part name → Drive file ID)
  - Upserts to SQLite, soft-deletes inactive songs
  - Progress callback for live UI updates
- Full Repertoire view (`src/views/Repertoire.jsx`)
  - Colour-coded index badges by type/subtype
  - Search by title or index
  - Filter chips by type and subtype
  - Song detail modal (parts list, Drive folder ID)
  - Expandable warnings panel after sync
  - Key variants shown as `Bb`, `Am` etc. (no `#` prefix)

### ✅ Step 3 — Setlist Builder (COMPLETE)
- Gig list view sorted by date; create new gig via modal form
- "Copy sets from" dropdown in new-gig form to pre-populate from an existing gig
- Two-panel editor: Repertoire panel (left) + N set columns (right, horizontally scrollable)
- Drag songs from Repertoire panel into any set column (`dnd-kit`)
- Drag to reorder entries within a set; drag entries across sets
- No duplicate songs within a gig (used songs dimmed in left panel)
- Gig properties: name, band name, venue, date, time (auto-save with debounce)
- N sets per gig — add / rename / delete sets
- Lock/unlock toggle: historic/seed gigs load locked; new gigs start unlocked
- Print sublists deferred to V2
- Backward compat: flat `string[]` setlist format parsed as single "Set 1"

### 🔲 Step 4 — PDF Generation
- Part resolution engine
- `pdf-lib` merge (individual + combined per instrument)
- Drive upload to `Setlists/<gig>/<instrument>/`
- Live log UI
- Print sublist support

### 🔲 Step 5 — Settings
- Blacklist management
- Instrument seat config (raw names, alt chains, order)
- Master folder name
- Cache clear (wipe SQLite)

### 🔲 Phase 2 — Future (not yet designed)
- Gig tracker (attendance, post-gig notes)
- Personnel manager (band member profiles)
- Payments (per-gig pay, running totals)
- Google Sheets write-back
- Band profile (name, logo) — replaces hardcoded "Vintage Ties" references

---

## Future Tasks (logged)

### Key tracking in Drive folders
**Goal:** Update Drive folder naming to include the key for EVERY song (not just key variants).
E.g. `1014 There ain_t no sweet man [C]` — the `[C]` suffix indicates the song's key.

**Why:** Once all songs have keys in Drive, the sync engine can store `key` in the songs table.
The Setlist Builder can then warn if two consecutive songs in a set are in the same key — helping
the bandleader avoid monotonous key sequences.

**Implementation sketch:**
1. Update Drive folder naming convention to append `[<Key>]`
2. Update `sync.js` parser to extract the key from folder name
3. Add `key TEXT NULL` column to `songs` table (schema migration)
4. In Setlist Builder / `GigEditor`, compute consecutive-key pairs per set and show a warning badge

---

## Bug History

### Bug 1 — Auth button stuck on failure ✅ Fixed
**Symptom:** Clicking Sign In with wrong account left button grey forever.
**Fix:** Reset `authState` to `'idle'` on any sign-in failure instead of `'error'`.

### Bug 2 — Successful sign-in doesn't transition to app ✅ Fixed (multi-stage)
Six root causes resolved in sequence:

| Stage | Root cause | Fix |
|---|---|---|
| 2a | GSI + gapi parallel init — gapi script tag caused GSI popup context to be marked `closed` | Removed gapi from static script tags; load dynamically after auth |
| 2b | React StrictMode double-invoked `initGsi()`, creating two token clients | Moved `initGsi()` to module level outside component |
| 2c | Chrome popup blocker — GSI defers `window.open` to `setTimeout`, which Chrome blocks | Abandoned popup flow; switched to full-page redirect |
| 2d | PKCE code exchange requires `client_secret` (Web app client) | Created Desktop app OAuth client |
| 2e | Desktop app client also requires `client_secret` (Google policy change) | Temporarily included secret in source code |
| 2f | Secret in public GitHub repo | Deployed Cloudflare Worker to handle token exchange server-side |

---

## Coding Conventions

- **Language:** JavaScript (ES modules) + React JSX
- **Styling:** CSS Modules — one `.module.css` per component, `className={styles.x}`
- **Comments:** Detailed — every function documented, every non-obvious line explained,
  every JS pattern explained in plain English on first use in a file
- **No magic:** regexes explained with examples, no clever one-liners without comment
- **DB access:** always via `db.exec(sql, params)` or `db.run(sql, params)` from `src/db/index.js`
- **Drive access:** always via `window.gapi.client.drive.files.list(...)` — never raw fetch to Drive
- **Error handling:** all async functions wrapped in try/catch with console.error logging

---

## Key Files Reference

| File | Purpose |
|---|---|
| `src/auth/google.js` | All Google auth logic: GSI init, PKCE redirect, token storage, gapi init |
| `src/db/index.js` | DB façade — `db.exec()` and `db.run()` used everywhere |
| `src/db/worker.js` | SQLite WASM Web Worker — owns the actual DB connection |
| `src/db/schema.js` | All `CREATE TABLE` statements |
| `src/config/seed.js` | First-run data: type map, part definitions, blacklist, 5 gigs |
| `src/drive/sync.js` | Drive → SQLite sync engine |
| `src/views/Repertoire.jsx` | Main song library view |
| `vite.config.js` | `base: '/fletcher/'`, COOP/COEP headers, sqlite-wasm exclusion |
| `.github/workflows/deploy.yml` | GitHub Actions deploy to Pages |

---

## Environment Notes

- **Dev server:** `npm run dev` → `http://localhost:5173/fletcher/`
- **Hard refresh:** `Ctrl+Shift+R` (clears Vite cache)
- **Console:** `F12` → Console tab — all `[auth]`, `[db/worker]`, `[schema]`, `[seed]`, `[Sync]` logs
- **OPFS database:** persists in Chrome's Origin Private File System — survives page reloads
- **Session token:** stored in `sessionStorage` — survives page reload, cleared on tab close
- **GitHub Actions:** every push to `main` triggers a build + deploy automatically
- **Cloudflare Worker:** always live at `https://fletcher-auth-worker.zvonkinm.workers.dev/token`

---

## Account Summary

| Service | Account | Notes |
|---|---|---|
| GitHub | `zvonkinm` | Repo: `zvonkinm/fletcher` |
| Google (dev) | `zvonkinm@gmail.com` | Test user, Drive folder shared here |
| Google (band) | `vintagetiesjazz@gmail.com` | Owns "The Vintage Ties 2021" Drive folder |
| Google Cloud | `zvonkinm@gmail.com` | Project: Fletcher |
| Cloudflare | `zvonkinm` | Worker: `fletcher-auth-worker.zvonkinm.workers.dev` |

---

## PRD

Full PRD is at `Fletcher_PRD_v1.1.docx` (generated separately).
Current version: **v1.1** — all architectural decisions resolved, browser app confirmed.