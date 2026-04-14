import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],

  // GitHub Pages serves the app at /fletcher/
  base: '/fletcher/',

  server: {
    // COOP + COEP headers required for SharedArrayBuffer (SQLite WASM)
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },

  optimizeDeps: {
    // sqlite-wasm ships its own WASM; exclude from Vite pre-bundling
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
})
