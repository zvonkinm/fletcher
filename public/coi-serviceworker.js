/* coi-serviceworker — adds COOP/COEP headers on GitHub Pages so that
 * SharedArrayBuffer (required by SQLite WASM) is available.
 *
 * This file is intentionally dual-mode:
 *   • Loaded as a <script> in the page → registers itself as a service worker,
 *     then reloads once so the SW is in control before the app boots.
 *   • Loaded as a service worker       → intercepts every fetch and injects
 *     Cross-Origin-Opener-Policy: same-origin
 *     Cross-Origin-Embedder-Policy: require-corp
 *
 * Based on https://github.com/gzuidhof/coi-serviceworker (MIT licence).
 */

if (typeof window === 'undefined') {
  // ── Service worker context ───────────────────────────────────────────────

  self.addEventListener('install', () => self.skipWaiting())
  self.addEventListener('activate', e => e.waitUntil(self.clients.claim()))

  self.addEventListener('fetch', e => {
    const req = e.request
    // Skip opaque cross-origin cache-only requests (would throw)
    if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return

    e.respondWith(
      fetch(req).then(res => {
        // Opaque responses (cross-origin no-cors) cannot be cloned with new headers
        if (res.status === 0) return res

        const headers = new Headers(res.headers)
        headers.set('Cross-Origin-Opener-Policy', 'same-origin')
        headers.set('Cross-Origin-Embedder-Policy', 'require-corp')
        return new Response(res.body, {
          status:     res.status,
          statusText: res.statusText,
          headers,
        })
      })
    )
  })

} else {
  // ── Main thread context — register the SW, reload once when it takes over ──

  if (!('serviceWorker' in navigator)) {
    console.warn('[coi] Service workers not supported — SharedArrayBuffer may be unavailable')
  } else if (navigator.serviceWorker.controller) {
    // Already controlled: SW is active, no reload needed
  } else {
    // First visit: register, then reload once so the SW intercepts from the start
    navigator.serviceWorker.register(document.currentScript.src)
      .then(reg => {
        reg.addEventListener('updatefound', () => {
          reg.installing?.addEventListener('statechange', e => {
            if (e.target.state === 'activated') location.replace('/fletcher/')
          })
        })
        if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' })
      })
    // Always reload to the base path so GitHub Pages never sees a sub-route
    // URL like /fletcher/gigs that it can't serve as a file.
    navigator.serviceWorker.addEventListener('controllerchange', () => location.replace('/fletcher/'))
  }
}
