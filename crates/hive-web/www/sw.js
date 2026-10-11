// The phone page when the server is not reached, and at once when it is: its files as last fetched,
// served from here, and fetched again behind them, so the next open has what changed. The list is
// shell.json, which build.sh writes.
const CACHE = "hive-web";

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const shell = await (await fetch("shell.json", { cache: "no-cache" })).json();
    await (await caches.open(CACHE)).addAll(shell);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const kept = await cache.match(req, { ignoreSearch: true, ignoreVary: true });
    const fresh = fetch(req).then(async (res) => {
      // The same file again (its ETag) is not written again: the wasm is megabytes.
      if (res.ok && res.headers.get("etag") !== kept?.headers.get("etag")) await cache.put(req, res.clone());
      return res;
    });
    if (!kept) return fresh;
    event.waitUntil(fresh.catch(() => {}));
    return kept;
  })());
});
