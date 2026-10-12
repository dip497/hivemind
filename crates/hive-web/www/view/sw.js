// A view's files, on the views' origin (docs/design/phone-browser-2026-10-03.md §11.6): each one its
// page asks for is asked of the frame showing it (shell.js), which asks the phone page, which asks the
// computer (`view.file`), and served under the policy the computer gives it. The view is at
// /v/<token>/; a path from its root (`/__sdk.js`) is its package's root, as on the computer.
"use strict";

const PATIENCE = 30_000;
const NONE = { "content-type": "text/plain", "content-security-policy": "default-src 'none'; sandbox" };
// Registered by a view for another scope (its shell's, say), it does nothing there.
const MINE = self.registration.scope === new URL("/v/", location.origin).href;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => MINE && event.respondWith(answer(event)));

/** The view's token and the path in its package `url` names, `from` the page asking. */
function placed(url, from) {
  const at = /^\/v\/([\w-]{16,64})\/(.*)$/.exec(url.pathname);
  if (at) return { token: at[1], path: at[2] };
  const of = from && /^\/v\/([\w-]{16,64})\//.exec(new URL(from).pathname);
  return of ? { token: of[1], path: url.pathname.slice(1) } : null;
}

async function answer(event) {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin || event.request.method !== "GET") return new Response("", { status: 404, headers: NONE });
  const from = event.clientId ? await self.clients.get(event.clientId) : null;
  const at = placed(url, from?.url);
  let path = null;
  try {
    path = at && at.path.split("/").map(decodeURIComponent);
  } catch {}
  if (!at || !path || path.some((s) => s === "" || s === "." || s === ".." || /[\\\0]/.test(s))) return new Response("", { status: 404, headers: NONE });
  const file = await ask(at.token, path.join("/"));
  if (!file) return new Response("", { status: 404, headers: NONE });
  return new Response(file.data, {
    headers: {
      "content-type": file.type,
      "content-security-policy": file.csp,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

/** The file at `path` of the view `token` names, from the frame showing it; null when there is none. */
async function ask(token, path) {
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const shell = all.find((c) => {
    const u = new URL(c.url);
    return u.pathname === "/" && u.searchParams.get("s") === token;
  });
  if (!shell) return null;
  const { port1, port2 } = new MessageChannel();
  const got = new Promise((done) => {
    port1.onmessage = (m) => done(m.data);
    setTimeout(() => done(null), PATIENCE);
  });
  shell.postMessage({ t: "file", token, path }, [port2]);
  const file = await got;
  port1.close();
  return file && file.data instanceof Uint8Array && typeof file.type === "string" && typeof file.csp === "string" ? file : null;
}
