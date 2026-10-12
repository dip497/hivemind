// The phone page, never older than the server's: each open asks the server for the page's hash
// (page.sha256, which build.sh writes), and a page not yet had is fetched whole, as shell.json lists
// it, into a cache of its own before it is shown, so files of two builds never run together. With
// the server not answering, the page last had opens.
const PREFIX = "hive-web-";
/** How long an open waits on the server's answer before it opens the page it has. */
const ASK_MS = 3000;
/** How long an open waits on a new page before it opens the one it has; the fetch goes on. */
const FETCH_MS = 20000;
/** In a page's cache once every file of it is: when it was had. */
const WHOLE = "page.sha256";

/** The cache each open page runs from, so a file it asks for later is of its own build: kept, as
 *  the browser stops a worker left idle. */
const RUNNING = "hive-web:running";
/** Pages being fetched, by hash. */
const fetching = new Map();

const late = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error("late")), ms));

/** The newest page had whole: its cache's name. */
async function newest() {
  let best;
  for (const name of await caches.keys()) {
    if (!name.startsWith(PREFIX)) continue;
    const whole = await (await caches.open(name)).match(WHOLE);
    const at = whole && Number(await whole.text());
    if (at && (!best || at > best.at)) best = { name, at };
  }
  return best?.name;
}

async function runs(client) {
  return (await (await caches.open(RUNNING)).match(`running/${client}`))?.text();
}

async function run(client, name) {
  await (await caches.open(RUNNING)).put(`running/${client}`, new Response(name));
}

/** The caches of pages neither `name`, open nor being fetched, dropped, and the pages closed. */
async function prune(name) {
  const running = await caches.open(RUNNING);
  const open = new Set();
  for (const key of await running.keys()) {
    const client = new URL(key.url).pathname.split("/").pop();
    if (await self.clients.get(client)) open.add(await (await running.match(key)).text());
    else await running.delete(key);
  }
  for (const other of await caches.keys()) {
    if (other.startsWith(PREFIX) && other !== name && !open.has(other) && !fetching.has(other.slice(PREFIX.length))) await caches.delete(other);
  }
}

/** Page `hash` from the server, whole, in its cache. */
function fetchPage(hash) {
  let had = fetching.get(hash);
  if (!had) {
    const name = PREFIX + hash;
    had = (async () => {
      const cache = await caches.open(name);
      if (await cache.match(WHOLE)) return name;
      // Not had whole, it is never run, and the next open drops it.
      const shell = await (await fetch("shell.json", { cache: "no-store" })).json();
      await Promise.all(shell.map(async (file) => {
        const res = await fetch(file, { cache: "no-cache" });
        if (!res.ok) throw new Error(`${file}: ${res.status}`);
        await cache.put(file, res);
      }));
      await cache.put(WHOLE, new Response(String(Date.now())));
      return name;
    })().finally(() => fetching.delete(hash));
    fetching.set(hash, had);
  }
  return had;
}

/** The cache an open runs from: the server's page when it answers, else the newest had. */
async function pageFor(event) {
  let hash;
  try {
    const res = await fetch(WHOLE, { cache: "no-store", signal: AbortSignal.timeout(ASK_MS) });
    if (res.ok) hash = (await res.text()).trim();
  } catch {}
  if (!hash) return newest();
  const had = fetchPage(hash);
  event.waitUntil(had.catch(() => {}));
  try {
    return await Promise.race([had, late(FETCH_MS)]);
  } catch {
    return newest();
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    await fetchPage((await (await fetch(WHOLE, { cache: "no-store" })).text()).trim());
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => event.waitUntil((async () => {
  await self.clients.claim();
  // Opened from the server as this worker fetched the page: of that build.
  const name = await newest();
  for (const client of await self.clients.matchAll()) if (name && !(await runs(client.id))) await run(client.id, name);
  // What an older worker kept.
  await caches.delete("hive-web");
})()));

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Asked not to be kept: what the server says now, or nothing.
  if (req.method !== "GET" || req.cache === "no-store" || new URL(req.url).origin !== location.origin) return;
  event.respondWith((async () => {
    const opening = req.mode === "navigate";
    const name = opening ? await pageFor(event) : await runs(event.clientId) ?? await newest();
    if (opening && name) {
      await run(event.resultingClientId, name);
      event.waitUntil(prune(name));
    }
    const cache = name && await caches.open(name);
    const kept = cache && await cache.match(req, { ignoreSearch: true, ignoreVary: true });
    return kept ?? fetch(req);
  })());
});
