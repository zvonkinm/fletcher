// src/db/index.js
// Main-thread façade over the SQLite WASM worker.
// Usage:
//   import { db } from './db'
//   await db.ready
//   const songs = await db.exec('SELECT * FROM songs')

import DbWorker from './worker.js?worker'
import { applySchema } from './schema.js'
import { seedIfEmpty } from '../config/seed.js'

class Database {
  constructor() {
    this._worker = new DbWorker()
    this._pending = new Map()
    this._seq = 0
    this._worker.onmessage = this._onMessage.bind(this)

    // Resolves once the worker signals 'ready' and schema + seed are applied
    this.ready = new Promise((resolve, reject) => {
      this._resolveReady = resolve
      this._rejectReady = reject
    })
  }

  _onMessage({ data }) {
    if (data.type === 'ready') {
      // Worker is up — apply schema then seed
      applySchema(this)
        .then(() => seedIfEmpty(this))
        .then(() => this._resolveReady())
        .catch(this._rejectReady)
      return
    }

    const pending = this._pending.get(data.id)
    if (!pending) return

    this._pending.delete(data.id)

    if (data.type === 'error') {
      pending.reject(new Error(data.message))
    } else {
      pending.resolve(data)
    }
  }

  _send(type, sql, params = []) {
    const id = ++this._seq
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject })
      this._worker.postMessage({ id, type, sql, params })
    })
  }

  /** Run a SELECT — returns array of row objects. */
  async exec(sql, params = []) {
    const result = await this._send('exec', sql, params)
    return result.rows
  }

  /** Run INSERT / UPDATE / DELETE — returns { changes }. */
  async run(sql, params = []) {
    const result = await this._send('run', sql, params)
    return { changes: result.changes }
  }

  /** Convenience: run multiple statements in a transaction. */
  async transaction(fn) {
    await this.run('BEGIN')
    try {
      await fn(this)
      await this.run('COMMIT')
    } catch (err) {
      await this.run('ROLLBACK')
      throw err
    }
  }
}

export const db = new Database()
