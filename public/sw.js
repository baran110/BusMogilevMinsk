const CACHE = 'mm-static-v4'
const CORE = ['/', '/manifest.webmanifest', '/icon.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(CORE)))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await Promise.all((await caches.keys()).filter((key) => key !== CACHE).map((key) => caches.delete(key)))
    await self.clients.claim()
    // Retire already-open clients that still contain the unsafe demo fallback.
    for (const client of await self.clients.matchAll({ type: 'window' })) {
      if (!new URL(client.url).pathname.startsWith('/api/')) await client.navigate(client.url)
    }
  })())
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return
  event.respondWith(fetch(event.request).then((response) => {
    if (!response.ok) return response
    const copy = response.clone()
    event.waitUntil(caches.open(CACHE).then((cache) => cache.put(event.request, copy)))
    return response
  }).catch(async () => (await caches.match(event.request))
    || (event.request.mode === 'navigate' ? await caches.match('/') : undefined)
    || new Response('Сеть недоступна', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })))
})
