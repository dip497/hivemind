// The frame a view is shown in, on the views' own origin (docs/design/phone-browser-2026-10-03.md
// §11.6): nothing of the page's is reachable from here. It frames the view's page at
// /v/<token>/, whose files the service worker here asks the page for, through this frame; hands the
// view the port the page gives it for each of its pages; and leaves nothing of one view to the next.
"use strict";

(() => {
  const token = new URLSearchParams(location.search).get("s");
  /** The page's end of this frame, once it has said so. */
  let page = null;
  let frame = null;
  /** The service worker's requests for files, by number, waiting on the page. */
  const asked = new Map();
  let next = 0;

  addEventListener("message", (e) => {
    let host = null;
    try {
      host = new URL(e.origin).hostname;
    } catch {}
    if (page || e.source !== parent || host !== location.hostname || e.data?.t !== "start" || !e.ports[0]) return;
    page = e.ports[0];
    page.onmessage = (m) => told(m.data ?? {}, m.ports);
    start(String(e.data.page)).catch((err) => page.postMessage({ t: "failed", why: String(err?.message ?? err) }));
  });

  function told(m, ports) {
    if (m.t === "file") {
      const reply = asked.get(m.id);
      asked.delete(m.id);
      reply?.postMessage(m.file ?? null);
    } else if (m.t === "port" && ports[0] && frame) {
      // Its own origin only: a page it went to elsewhere is given nothing.
      frame.contentWindow.postMessage({ type: "hivemind-view:port" }, location.origin, [ports[0]]);
    } else if (m.t === "reload" && frame) {
      frame.src = frame.src;
    }
  }

  async function start(entry) {
    if (!token || !/^[\w-]{16,64}$/.test(token)) throw new Error("no token");
    await forget();
    navigator.serviceWorker.addEventListener("message", (e) => {
      const reply = e.ports[0];
      if (!reply || e.data?.t !== "file" || e.data.token !== token) return;
      const id = ++next;
      asked.set(id, reply);
      page.postMessage({ t: "file", id, path: String(e.data.path) });
    });
    navigator.serviceWorker.startMessages();
    const registration = await navigator.serviceWorker.register("sw.js", { scope: "./v/" });
    await activated(registration);
    frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
    frame.setAttribute("data-view", "");
    frame.addEventListener("load", () => {
      let home = false;
      try {
        home = frame.contentWindow.location.pathname.startsWith(`/v/${token}/`);
      } catch {}
      page.postMessage({ t: home ? "page" : "left" });
    });
    frame.src = `v/${token}/${entry.split("/").map(encodeURIComponent).join("/")}`;
    document.body.append(frame);
  }

  /** What a view before this one kept on this origin, gone. */
  async function forget() {
    localStorage.clear();
    sessionStorage.clear();
    const dbs = (await indexedDB.databases?.()) ?? [];
    await Promise.all(dbs.map((db) => new Promise((done) => {
      const gone = indexedDB.deleteDatabase(db.name);
      gone.onsuccess = gone.onerror = gone.onblocked = done;
    })));
    for (const name of await caches.keys()) await caches.delete(name);
    for (const c of document.cookie.split(";")) document.cookie = `${c.split("=")[0].trim()}=; path=/; max-age=0`;
  }

  function activated(registration) {
    const worker = registration.active ?? registration.waiting ?? registration.installing;
    return new Promise((done) => {
      if (worker.state === "activated") return done();
      worker.addEventListener("statechange", () => worker.state === "activated" && done());
    });
  }
})();
