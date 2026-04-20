# Fletcher — Project Design Document

**Owner:** Misha Zvonkin (`zvonkinm@gmail.com`) — sole user, bandleader of The Vintage Ties  
**Live URL:** https://zvonkinm.github.io/fletcher  
**Repo:** https://github.com/zvonkinm/fletcher  
**Last updated:** 2026-04-20

---

## 1. Project Objectives and Goals

Fletcher is a personal, browser-based band management application that replaces two manual tools:

- A Google Colab Python notebook (`VT_Book_Manager.ipynb`) used to assemble per-musician PDF setlists from Google Drive
- A spreadsheet used to track gigs, personnel, and payments

**Goals:**
1. Provide a fast, offline-capable browser UI for building gig setlists from the band's existing Google Drive song library
2. Export per-musician PDF packets to Drive automatically, matching the Colab notebook output exactly
3. Track personnel (musicians, their instruments, and location) across gigs
4. Manage the Line Up for each gig — assign musicians to instrument parts, mark unavailability
5. Persist all data locally in SQLite (OPFS) and sync back to Drive as `.info` files, so data survives across browser sessions and devices

**Non-goals (single-user app):**
- No multi-user access or sharing
- No backend database — all state lives in the browser (OPFS) and Drive sync files
- No authentication complexity beyond the owner's own Google account

---

## 2. Technology Stack

| Layer | Choice | Notes |
|---|---|---|
| Frontend | React 18 + Vite | Deployed as static site to GitHub Pages |
| Storage | `@sqlite.org/sqlite-wasm` + OPFS | Runs entirely in browser; persists across sessions |
| Auth | Google Identity Services (GSI) + PKCE redirect flow | No popup; redirect then callback |
| Auth backend | Cloudflare Worker (`fletcher-auth-worker.zvonkinm.workers.dev/token`) | Holds client secret server-side for token exchange |
| Drive API | `gapi` JS client (Drive API v3) | Loaded dynamically after auth |
| PDF merge | `pdf-lib` | Client-side PDF merge for per-part and all-parts export |
| Drag-and-drop | `dnd-kit` (`@dnd-kit/core`, `@dnd-kit/sortable`) | Song reorder + cross-set drag |
| Deploy | GitHub Pages | Auto-deploys via GitHub Actions on push to `main` |
| Styling | CSS Modules (`.module.css` per component) | `className={styles.x}` only |

**Google Cloud:**
- Web OAuth client: `1089043244006-h9kskqft3tn80j49m2fgl2d5j19rgvrm.apps.googleusercontent.com`
- Desktop/PKCE OAuth client: `1089043244006-3lm74io6nubokgkpv94uqg0kavo9s1ad.apps.googleusercontent.com`
- Drive scopes: `drive.readonly` (song library sync) + `drive.file` (PDF upload + sync folder)

---

## 3. Repository Structure

```
fletcher/
├── public/                    # Static assets (favicon, etc.)
├── src/
│   ├── App.jsx                # Root — auth state machine + route shell
│   ├── App.module.css
│   ├── assets/
│   │   └── logo.js            # Base64 portrait logo
│   ├── auth/
│   │   └── google.js          # GSI init, PKCE flow, token management
│   ├── components/
│   │   └── NavBar.jsx         # Top nav: logo + tabs + sign-out
│   ├── config/
│   │   └── seed.js            # Seed data inserted on first launch
│   ├── db/
│   │   ├── index.js           # Public db.exec / db.run wrappers
│   │   ├── schema.js          # CREATE TABLE + all migrations
│   │   └── worker.js          # SQLite WASM worker thread
│   ├── drive/
│   │   ├── export.js          # PDF export (copy + merge + upload)
│   │   ├── files.js           # fetchPdfBytes helper
│   │   ├── sync.js            # Song library sync from Drive
│   │   └── sync-gigs.js       # Gig / settings / musician Drive sync
│   └── views/
│       ├── Gigs.jsx           # Gig list + gig editor (setlist builder)
│       ├── Gigs.module.css
│       ├── Personnel.jsx      # Musician management
│       ├── Personnel.module.css
│       ├── Repertoire.jsx     # Song library browser + sync
│       ├── Repertoire.module.css
│       ├── Settings.jsx       # Drive folder + active parts settings
│       └── Settings.module.css
├── DESIGN.md                  # ← this file
├── vite.config.js
└── package.json
```

---

## 4. Database Schema

All tables live in an SQLite WASM database stored in OPFS (Origin Private File System). Schema is defined in `src/db/schema.js` and applied safely on every startup via `CREATE TABLE IF NOT EXISTS` + `PRAGMA table_info` migrations.

### `songs` table
| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | e.g. `"1023"`, `"1023#Am"` — `#Variant` suffix for alt-key versions |
| `idx` | TEXT | 4-digit index string, e.g. `"1023"` |
| `key_variant` | TEXT NULL | e.g. `"Am"`, `"Eb"` — null for base version |
| `title` | TEXT | Underscores in Drive folder names converted to apostrophes |
| `song_type` | TEXT | `Arrangements` / `Instrumentals` / `Lead Sheet` |
| `subtype` | TEXT | `Swing` / `12 Bar` / `Bluesy` |
| `drive_folder_id` | TEXT | Google Drive folder ID for the song |
| `parts` | TEXT | JSON: `{ "vocals": "fileId", "clarinet in bb": "fileId", … }` |
| `blacklisted` | INTEGER | 0 / 1 |
| `active` | INTEGER | 0 / 1 — set to 0 when folder disappears from Drive |
| `last_synced` | INTEGER | Unix timestamp ms |

### `gigs` table
| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | URL-safe slug, e.g. `"vtjb_highball_260401"` |
| `name` | TEXT | Human-readable name |
| `band_name` | TEXT NULL | Optional band override |
| `date` | TEXT NULL | ISO 8601, e.g. `"2026-04-01"` |
| `time` | TEXT NULL | Free-text start time, e.g. `"7:30 PM"` |
| `end_time` | TEXT NULL | Free-text end time, e.g. `"9:00 PM"` |
| `venue` | TEXT NULL | |
| `city` | TEXT NULL | Used for Line Up locality filtering |
| `state` | TEXT NULL | Used for Line Up locality filtering |
| `setlist` | TEXT | JSON: `[{ id, name, song_ids: string[] }]` (multi-set format); write-in slots stored as `wi:<randomId>:<title>` strings in `song_ids` |
| `print_sublists` | TEXT | JSON: `[{ name, song_ids: string[] }]` |
| `locked` | INTEGER | 0 / 1 — locked gigs are read-only |
| `parts` | TEXT NULL | JSON: `string[]` — active parts for this specific gig |
| `lineup` | TEXT NULL | JSON: `{ [partName]: { assigned: id\|null, declined: id[] } }` |
| `financials` | TEXT NULL | JSON: payment data — see Payment Info panel below |

### `musicians` table
| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | Random 8-char alphanumeric |
| `name` | TEXT | Musician's full name |
| `parts` | TEXT | JSON: `string[]` — instrument parts this musician plays |
| `city` | TEXT NULL | Used for Line Up locality filtering |
| `state` | TEXT NULL | Used for Line Up locality filtering |
| `locked` | INTEGER | 0 / 1 — locked musicians are read-only |

### `settings` table (key/value store)
| Key | Value (JSON) | Notes |
|---|---|---|
| `root_drive_folder` | `"The Vintage Ties 2021"` | Path to root Drive folder; slashes for nested |
| `active_parts` | `["Clarinet", "Trumpet", …]` | All instrument parts known to the system |
| `part_definitions` | `{ partName: { raw: [], alt: [] } }` | Part resolution rules for export |
| `last_synced` | timestamp ms | When the song library was last synced |
| `seeded` | `1` | Internal flag: prevents re-seeding on subsequent launches |

### `financials` JSON shape (stored in `gigs.financials`)
| Field | Type | Notes |
|---|---|---|
| `contract_pay` | number\|null | Agreed payment amount |
| `contract_pay_mode` | `"total"` \| `"per_person"` | Whether the amount is total or per musician |
| `extra_expenses` | number\|null | Out-of-pocket costs to subtract from total |
| `extra_expenses_memo` | string | Free-text description of the expense |
| `venue_pay` | number\|null | Cash received from the venue |
| `venmo_tips` | number\|null | Tips collected via Venmo |
| `cash_tips` | number\|null | Cash tips collected |
| `paid_per_person` | number\|null | Actual amount sent to each musician |
| `exclude_bandleader` | boolean | If true, hired count = assigned − 1 (default true) |
| `paid_musicians` | `{ [musicianId]: boolean }` | Per-musician paid flag |

Computed (not stored): Total Tips = venmo + cash; Total Pay = venue + tips − expenses; Per Person Pay = total / assigned count; Total Paid Out = paid_per_person × hired count; To Band Fund = Total Pay − paid_per_person × all assigned count.

### Migrations
`schema.js` runs `PRAGMA table_info` on startup and uses `ALTER TABLE ADD COLUMN` for any missing columns. All migrations are idempotent and logged. Historical migrations:
- `gigs`: added `band_name`, `time`, `end_time`, `locked`, `parts` (renamed from `seats`), `city`, `state`, `lineup`, `financials`
- `musicians`: added `city`, `state`
- `settings`: renamed `active_seats` → `active_parts`; renamed `export_folder_name` / `master_folder_name` → `root_drive_folder`

---

## 5. Drive Sync Architecture

### Sync folder layout
```
<root_drive_folder>/
  Fletcher Sync/
    settings.info    — { version, savedAt, settings: [{ key, value }] }
    gigs.info        — { version, savedAt, gigs: [...rows] }
    musicians.info   — { version, savedAt, musicians: [...rows] }
  Setlists/
    <gig name>/
      <part>/
        <songId> - <title> - <part>.pdf   ← individual PDFs
        ALL - <gig name> - <part>.pdf     ← per-part merged
      ALL PARTS - <gig name>.pdf          ← full merge
```

### Sync pattern
All sync functions in `src/drive/sync-gigs.js` are **non-fatal fire-and-forget**: errors are logged but never propagate to the UI. The local SQLite DB is always the source of truth; Drive is a persistence/portability layer.

On sign-in (or session restore), the app loads in order:
1. `loadSettingsFromDrive()` — restores `root_drive_folder` and `active_parts`
2. `loadGigsFromDrive()` — replaces all local gigs
3. `loadMusiciansFromDrive()` — replaces all local musicians

After any mutation, the corresponding save function is called fire-and-forget:
- `saveSettingsToDrive()`
- `saveGigsToDrive()`
- `saveMusiciansToDrive()`

### PDF Export (`src/drive/export.js`)
Mirrors the Colab notebook's `CreateCollection` function exactly:
1. Resolve parts for each song using `part_definitions` (raw name match → alt chain fallback)
2. Find/create folder tree: `root/Setlists/<gig name>/<part>/`
3. Clear existing PDFs from part folders
4. `files.copy` individual PDFs server-side (no download)
5. Fetch originals, merge per part with `pdf-lib`, upload `ALL - <gig name> - <part>.pdf`
6. Concatenate per-part merges into `ALL PARTS - <gig name>.pdf`

Progress is reported via `onProgress(msg)` and `onStageProgress(label, done, total)` callbacks for the live log UI.

---

## 6. Application Routes and Views

| Route | View | Description |
|---|---|---|
| `/` | → redirect to `/gigs` | |
| `/repertoire` | `Repertoire` | Song library browser, Drive sync trigger, PDF preview |
| `/gigs` | `GigList` | All gigs as date-sorted cards |
| `/gigs/:gigId` | `GigEditor` | Full gig editor (see below) |
| `/personnel` | `Personnel` | Musician roster management |
| `/settings` | `Settings` | Drive folder path + active parts config |

---

## 7. Implemented Features

### Auth
- PKCE redirect flow via Google Identity Services — no popup
- Token exchange via Cloudflare Worker (keeps client secret server-side)
- Session restore from `sessionStorage` on page reload
- Graceful degradation to sign-in screen on any auth failure

### Repertoire (`/repertoire`)
- Sync song library from Google Drive (scans configured root folder)
- Full-text search across song titles
- Filter by song type (Arrangements / Instrumentals / Lead Sheet) and subtype (Swing / 12 Bar / Bluesy)
- Colour-coded index badges per type/subtype
- Song detail panel: shows all available parts as clickable cards; clicking a part opens the PDF viewer
- Blacklist toggle (hides songs from setlist builder)
- Sync progress log with warnings for changed/missing songs

### Gigs — List (`/gigs`)
- Date-sorted card list of all gigs
- Each card shows:
  - Name, band name, lock badge
  - Date · Start–End time (e.g. `7:30 PM–9:00 PM`) · Venue
  - Line up chips — one pill per active part, sorted assigned first:
    - Assigned: **bold part name** + musician name in a grey pill
    - Unassigned: part name in a red pill (signals the slot still needs filling)
  - Set count · song count
- "+ New Gig" opens creation modal

### Gigs — Creation Modal (GigForm)
Fields: name *(required)*, band name, date *(required)*, start time, end time, venue, city, state  
Parts selection: checkboxes for all `active_parts`; defaults to all selected  
Copy sets: optional dropdown to copy setlist structure from an existing gig  
Saves to DB + fires Drive sync; navigates to editor on save

### Gigs — Editor (`/gigs/:gigId`)
**Header:** gig name, band name, date, start time, end time, venue — inline editable, auto-saved 400 ms after last change. Lock button toggles read-only mode. Export button opens export modal.

**Parts row:** Checkboxes for `active_parts`; checked parts are active for this gig and used during export. Unchecked parts show greyed "N/A" in the Line Up. Part chips are disabled (non-clickable) when the gig is locked.

**Line Up section** (between Parts and Setlist):
- Per-part columns laid out horizontally, scrollable
- Each active part has a custom `MusicianPicker` dropdown beneath it
- Inactive parts show a greyed "N/A" pill
- Dropdown lists musicians who play that part; sorted: assigned → declined (alphabetical) → available (alphabetical)
- Within the dropdown, each musician row has a ✕ button to mark them as unavailable (red, strikethrough)
- "Show only local musicians" checkbox filters the picker to musicians matching the gig's city/state (musicians with no location data are always shown)
- Lineup is auto-saved 300 ms after last change (debounced via `latestLineupRef` + `lineupSaveRef` pattern)
- Dropdown panel uses `position: fixed` + `getBoundingClientRect()` to escape any `overflow: auto` ancestors; flips upward when near the viewport bottom

**Setlist builder:**
- Multi-set layout: each set is a named, vertically sorted list of songs
- Drag songs from the Repertoire panel (right) into any set
- Drag to reorder within a set; drag between sets
- Per-entry key override: small inline text input next to each song (stores as `songId#KeyVariant`, e.g. `"1023#Am"`)
- "Add set" button appends a new empty set
- Set names are inline-editable
- Individual songs and entire sets can be deleted
- Song appears in the Repertoire panel as "in setlist" badge when added; cannot be added twice
- Repertoire panel includes search + type/subtype filter
- **Write-in entries:** "+ Write-in" button at the bottom of each set column adds a placeholder slot with a custom, inline-editable title and a solid black `XXXX` index pill; write-ins are stored as `wi:<randomId>:<title>` in `song_ids` and are silently skipped during PDF export

**Export modal:**
- Triggered from header "Export" button (disabled if gig is locked)
- Shows live log of progress messages
- Per-stage progress bar (resets between phases: folder setup → copy PDFs → merge per part → full merge)
- Warnings shown inline (songs missing a part file); export continues despite warnings
- "Done" button appears when complete; shows error count if any

**Payment Info panel** (between Line Up and Setlist):
- Collapsible (collapsed by default); collapsed header shows a brief summary of any entered values
- Editable fields: Contract Pay (with per-person / total toggle), Extra Expenses + memo, Pay from Venue, Venmo Tips, Cash Tips, Paid Per Person
- Computed read-only row: Total Tips (Venmo + Cash), Total Pay (venue + tips − expenses), Per Person Pay (total ÷ assigned musician count)
- Musician payment list: one row per assigned musician with a paid/unpaid checkbox; paid rows turn green
- All inputs become read-only when the gig is locked
- Auto-saved to `gigs.financials` (debounced 600 ms) and synced to Drive via `gigs.info`

**Locking:** Locked gigs are fully read-only — all inputs disabled, part chips disabled, no drag-and-drop, no export.

### Personnel (`/personnel`)
- Musician list sorted by name
- Filter chips by instrument part
- "+ Add Musician" modal: name, instruments (checkboxes), city, state; saved locked=1
- Musician cards:
  - Unlocked: inline name edit, instrument checkboxes, city/state inputs (save on blur or Enter)
  - Locked: name, instrument chips (read-only), city/state label
  - Lock toggle button with text labels ("🔒 Locked" / "🔓 Unlocked")
  - Delete button (only when unlocked)
- All mutations saved to SQLite immediately + Drive sync fire-and-forget

### Settings (`/settings`)
- **Drive section:** Root Drive folder path (slash-separated for nested folders); validated against Drive before saving; shows folder path hint for exports and sync
- **Parts section:** Add/remove instrument parts; chips with × remove button; changes synced to Drive
- **Diagnostic table:** All non-editable settings displayed as formatted JSON (read-only)

---

## 8. Planned Features (Not Yet Implemented)

### High-priority / clearly scoped

1. **Print sublists UI** — The `print_sublists` column exists in the DB and is saved, but there is no UI to create, edit, or export named sublists (e.g. "First set only", "Slow songs"). The export logic already supports them at the data layer.

2. **Part definitions UI** — `part_definitions` (raw name aliases + alt chain for export resolution) is stored in settings but has no editor. Currently must be manually inserted into the DB or set via the Colab notebook.

3. **Song blacklist UI in Repertoire** — The blacklist column exists and the toggle is present in the song detail panel; however, the Repertoire filter UI does not yet have a "show blacklisted" toggle. Blacklisted songs are correctly hidden from setlist builder already.

4. **Keyboard accessibility in MusicianPicker** — The custom dropdown is mouse/touch only. Arrow keys, Enter, and Escape are not wired up.

5. **Responsive / mobile layout** — All views are designed for desktop-width browsers. The GigEditor in particular (multi-panel layout with Line Up columns + side-by-side setlist/repertoire) will break on narrow screens.

### Future / Phase 2

6. ~~**Payments tracking**~~ — **Implemented** as the Payment Info panel (see above).

7. **Gig notes field** — The `notes` column exists in the `gigs` table but is not surfaced in the editor UI.

8. **Duplicate song warning** — When dragging a song that already appears in a different set, a warning should appear. Currently the UI only blocks adding the same song to the same set; the cross-set check is incomplete.

9. **Cache clear / DB reset in Settings** — No way to wipe local SQLite state and re-sync from Drive. Useful for resolving corruption or switching browsers.

10. **Drive-side delete cleanup** — When a gig is deleted locally, the export folder in Drive is not removed.

11. **Multi-set print sublists** — Currently sublists are flat song ID lists; they don't capture which set a song belongs to.

12. **Token refresh in export** — Long exports (many songs × parts) can exceed the OAuth token lifetime. The `tokenExpiresIn()` check runs before export but not mid-export.

---

## 9. Coding Conventions and Style Guide

All future work on this project must follow these conventions exactly. They are non-negotiable.

### Language
- JavaScript (ES modules) — **no TypeScript**
- React JSX — functional components only, hooks for state

### File structure
- One `.jsx` file per view or component
- One `.module.css` file per `.jsx` file with the same name
- No utility modules unless the utility is used in 3+ places

### CSS
- CSS Modules only — always `className={styles.x}`, never inline styles except for dynamic values (e.g. computed positions, colours from data)
- No global CSS except `index.css` for resets
- Colour palette: Navy `#1B2B4B`, Border `#D0D9E8`, Background `#EFF2F7`, Muted `#A0AEC0`
- Border radius convention: cards 10px, buttons 8px, chips 6–20px, inputs 6–8px

### Comments — mandatory and verbose
- Every function must have a comment above it describing what it does and why
- Non-obvious logic must have an inline comment
- Regex patterns must be explained with an example
- First use of any non-trivial pattern in a file (e.g. `latestRef` closure trick, OPFS, gapi error normalisation) must have a plain-English explanation

### Database access
- Always use `db.exec(sql, params)` (returns rows) or `db.run(sql, params)` (no rows) from `src/db/index.js`
- Never call SQLite WASM APIs directly
- Dynamic UPDATE clauses must use an `ALLOWED_COLS` whitelist to guard against injection (see Personnel.jsx pattern)
- New columns must be added via migrations in `schema.js`, never by creating new tables

### Drive access
- Always use `window.gapi.client.drive.files.*` for Drive operations
- Never raw-fetch to Drive API except for `files.get?alt=media` (download) and multipart upload (create/update) — these two endpoints require raw fetch because gapi doesn't support streaming bodies
- Wrap all gapi calls in the `gapiExec(fn)` normaliser to get clean `Error` objects
- All Drive functions must be non-fatal: wrap in try/catch, log with `console.error`, never re-throw to caller

### Error handling
- All async functions must be wrapped in `try/catch` with `console.error('[ComponentName] Description:', err)`
- Drive sync errors must never block the UI
- DB errors in mutations should ideally revert optimistic UI state

### Naming
- Component names: PascalCase
- Hooks / functions: camelCase
- CSS classes: camelCase (CSS Modules handles scoping)
- Settings keys in DB: snake_case strings
- Gig IDs: auto-generated slugs, e.g. `vtjb_highball_260401`

### State patterns
- **Debounced auto-save with ref:** when a debounced callback needs the latest state but was closed over stale state, use the `latestXxxRef` + `xxxSaveRef` pattern:
  ```js
  const latestLineupRef = useRef(lineup)
  setLineup(prev => { const next = …; latestLineupRef.current = next; return next })
  // debounced save reads latestLineupRef.current, not lineup
  ```
- **Optimistic UI:** update React state immediately, then persist to DB. On error, revert.
- **Fire-and-forget Drive sync:** call `saveXxxToDrive()` without `await` after any mutation.

### Dropdown / overlay positioning
- Custom dropdown panels that live inside `overflow: auto` containers must use `position: fixed` with coordinates from `getBoundingClientRect()` — never `position: absolute`
- Reason: setting `overflow-x: auto` on a container implicitly forces `overflow-y` to non-`visible` per CSS spec, which clips absolutely positioned descendants
- Panels should flip upward when `r.bottom + panelHeight > window.innerHeight`

### Component communication
- Prefer lifting state to the nearest common ancestor
- Pass callbacks (`onUpdate`, `onDelete`, `onChange`) as props — no context API unless state is needed by 4+ levels of deeply nested components

---

## 10. Key Technical Learnings

### OPFS + SQLite WASM
- Must be served with COOP/COEP headers (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`) for SharedArrayBuffer support
- The DB worker (`src/db/worker.js`) must be a separate JS module loaded via `new Worker(..., { type: 'module' })`
- `db.ready` is a Promise that resolves when the DB is initialised; all DB callers must `await db.ready` before use (or use it as a loading gate in `App.jsx`)

### SQLite schema migrations
- `ALTER TABLE … ADD COLUMN IF NOT EXISTS` does not exist in SQLite — must use `PRAGMA table_info` + conditional `ALTER TABLE ADD COLUMN`
- Migrations run every startup; they must be idempotent and O(1) (no full-table rewrites)
- Column renames require creating a new column, copying data, and dropping the old — or (if the column is new enough) `ALTER TABLE RENAME COLUMN` (SQLite 3.25+)

### PDF.js in Vite
- `pdfjsLib.GlobalWorkerOptions.workerSrc` must be set to the worker file URL; use Vite's `?url` import to get the correct hashed path

### PKCE OAuth redirect flow
- The app fully navigates away to Google and returns via redirect; no state survives the navigation except `sessionStorage`
- PKCE verifier must be stored in `sessionStorage` before redirect and retrieved in the callback handler
- The Cloudflare Worker holds the `client_secret` for the token exchange POST

### `position: fixed` dropdown escape hatch
- The CSS spec states that `overflow: visible` cannot be combined with `overflow: auto` on the same axis — if you set `overflow-x: auto`, the browser silently promotes `overflow-y` to `auto` as well, clipping absolutely-positioned children
- Solution: compute `getBoundingClientRect()` of the trigger element, set the panel to `position: fixed` with those coordinates, and recalculate on every open

### dnd-kit multi-container drag
- Each set is a `SortableContext` with its own ID list; `DndContext` at the top level handles cross-set drags
- The `DragOverlay` component renders a ghost copy of the dragged item; it must receive the drag item's data via `useDraggable`'s `data` parameter
- `arrayMove` only works within the same array; cross-container moves require manually splicing the source and destination arrays

### Locality filtering for Line Up
- A musician with no `city` and no `state` is always treated as local (shown by default) — covers the common case where location data is incomplete
- Filtering logic: if the musician has a state, it must match the gig's state; if the musician has a city, it must match the gig's city
- Declined musicians (✕ marked) are always shown regardless of the local filter — once called, they appear even if they don't match location
