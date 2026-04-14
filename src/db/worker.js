// src/db/worker.js
// Runs inside a Web Worker. Owns the sqlite-wasm instance and OPFS database.
// Communicates with the main thread via postMessage.

import sqlite3InitModule from '@sqlite.org/sqlite-wasm'

let db = null

async function init() {
  const sqlite3 = await sqlite3InitModule({ print: console.log, printErr: console.error })

  // Use OPFS if available (persistent across sessions), fall back to in-memory
  if (sqlite3.capi.sqlite3_vfs_find('opfs')) {
    db = new sqlite3.oo1.OpfsDb('/fletcher.db')
    console.log('[db/worker] Opened OPFS database at /fletcher.db')
  } else {
    db = new sqlite3.oo1.DB('/fletcher.db', 'ct')
    console.warn('[db/worker] OPFS unavailable — using in-memory DB (data will not persist)')
  }

  postMessage({ type: 'ready' })
}

function exec(sql, params = []) {
  const rows = []
  db.exec({
    sql,
    bind: params,
    rowMode: 'object',
    callback: (row) => rows.push(row),
  })
  return rows
}

function run(sql, params = []) {
  db.exec({ sql, bind: params })
  return { changes: db.changes() }
}

self.onmessage = ({ data }) => {
  const { id, type, sql, params } = data
  try {
    if (type === 'exec') {
      const rows = exec(sql, params)
      postMessage({ id, type: 'result', rows })
    } else if (type === 'run') {
      const result = run(sql, params)
      postMessage({ id, type: 'result', ...result })
    } else {
      postMessage({ id, type: 'error', message: `Unknown message type: ${type}` })
    }
  } catch (err) {
    postMessage({ id, type: 'error', message: err.message })
  }
}

init().catch((err) => {
  console.error('[db/worker] Init failed:', err)
  postMessage({ type: 'error', message: err.message })
})
