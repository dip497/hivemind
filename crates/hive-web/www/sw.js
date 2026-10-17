// The phone page, opened at once from the newest build had whole, never waiting on the network. Each
// open asks the server for the page's hash (page.sha256, which build.sh writes) alongside, and a
// build not yet had is fetched whole, as shell.json lists it, into a cache of its own: the next open
// runs it. Files of two builds never run together.
const PREFIX = "hive-web-";
/** How long the check for a new build waits on the server. */
const ASK_MS = 10000;
/** In a build's cache once every file of it is: when it was had. */
const WHOLE = "page.sha256";
/** The build each open page runs, kept, as the browser stops a worker left idle. */
const RUNNING = "hive-web:running";

/** The build each open page runs, as known since this worker started. */
const running = new Map();
/** Builds being fetched, by hash. */
const fetching = new Map();
/** The newest build had whole: its cache's name. */
let current;

const newest = () => (current ??= (async () => {
  let best;
  for (const name of await caches.keys()) {
    if (!name.startsWith(PREFIX)) continue;
    const whole = await (await caches.open(name)).match(WHOLE);
    const at = whole && Number(await whole.text());
    if (at && (!best || at > best.at)) best = { name, at };
  }
  return best?.name;
})());

async function runs(client) {
  if (!running.has(client)) {
    const kept = await (await caches.open(RUNNING)).match(`running/${client}`);
    if (kept) running.set(client, await kept.text());
  }
  return running.get(client);
}

async function run(client, name) {
  running.set(client, name);
  await (await caches.open(RUNNING)).put(`running/${client}`, new Response(name));
}

/** The builds neither `name`, open nor being fetched, dropped, and the pages closed. */
async function prune(name) {
  const kept = await caches.open(RUNNING);
  const open = new Set();
  for (const key of await kept.keys()) {
    const client = new URL(key.url).pathname.split("/").pop();
    if (await self.clients.get(client)) open.add(await (await kept.match(key)).text());
    else {
      running.delete(client);
      await kept.delete(key);
    }
  }
  for (const other of await caches.keys()) {
    if (other.startsWith(PREFIX) && other !== name && !open.has(other) && !fetching.has(other.slice(PREFIX.length))) await caches.delete(other);
  }
}

/** Build `hash` from the server, whole, in its cache; the newest from then on. */
function fetchBuild(hash) {
  let had = fetching.get(hash);
  if (!had) {
    const name = PREFIX + hash;
    had = (async () => {
      const cache = await caches.open(name);
      // Not had whole, it is never run, and a later open drops it.
      if (!(await cache.match(WHOLE))) {
        const shell = await (await fetch("shell.json", { cache: "no-store" })).json();
        await Promise.all(shell.map(async (file) => {
          const res = await fetch(file, { cache: "no-cache" });
          if (!res.ok) throw new Error(`${file}: ${res.status}`);
          await cache.put(file, res);
        }));
        await cache.put(WHOLE, new Response(String(Date.now())));
      }
      current = Promise.resolve(name);
      return name;
    })().finally(() => fetching.delete(hash));
    fetching.set(hash, had);
  }
  return had;
}

/** The server's build, fetched when new; with nothing new, the builds no page runs are dropped. */
async function check() {
  const res = await fetch(WHOLE, { cache: "no-store", signal: AbortSignal.timeout(ASK_MS) });
  if (!res.ok) return;
  const name = PREFIX + (await res.text()).trim();
  if (name !== await newest()) await fetchBuild(name.slice(PREFIX.length));
  else await prune(name);
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    await fetchBuild((await (await fetch(WHOLE, { cache: "no-store" })).text()).trim());
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => event.waitUntil((async () => {
  await self.clients.claim();
  // Opened from the server as this worker fetched the build: of that build.
  const name = await newest();
  for (const client of await self.clients.matchAll()) if (name && !(await runs(client.id))) await run(client.id, name);
  // What an older worker kept.
  await caches.delete("hive-web");
})()));

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Asked not to be kept: what the server says now, or nothing.
  if (req.method !== "GET" || req.cache === "no-store" || new URL(req.url).origin !== location.origin) return;
  const opening = req.mode === "navigate";
  if (opening) event.waitUntil(check().catch(() => {}));
  event.respondWith((async () => {
    const name = opening ? await newest() : await runs(event.clientId) ?? await newest();
    if (opening && name) event.waitUntil(run(event.resultingClientId, name));
    const kept = name && await (await caches.open(name)).match(req, { ignoreSearch: true, ignoreVary: true });
    return kept ?? fetch(req);
  })());
});
