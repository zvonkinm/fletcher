# Fletcher

Jazz band management app for the Vintage Ties.

**Live app:** https://zvonkinm.github.io/fletcher

## Stack

- React + Vite
- SQLite WASM (OPFS) — persists in-browser, no backend
- Google Identity Services + Drive API v3
- pdf-lib (PDF merge)
- dnd-kit (drag-and-drop)
- GitHub Pages (deploy)

## Development

```bash
npm install
npm run dev
```

Requires a modern browser with SharedArrayBuffer support (Chrome 92+, Firefox 79+, Safari 15.2+).

## Deploy

Push to `main` — GitHub Actions builds and deploys automatically.

## Project structure

```
src/
  auth/       Google GSI + gapi init
  db/         SQLite WASM worker + façade + schema
  config/     Seed data (type map, part definitions, historical gigs)
  views/      Repertoire | Setlist | Settings
  components/ NavBar
```
