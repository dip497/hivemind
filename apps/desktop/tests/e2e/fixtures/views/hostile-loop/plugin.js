// A runaway view: connects politely, then burns ~40 ms of CPU on every frame
// forever. Also records what the sandbox lets it see (read by the e2e suite).
window.__seen = { hive: typeof window.hive, process: typeof process, require: typeof require, origin: location.origin, fetch: null };
fetch("https://example.com/").then(() => { window.__seen.fetch = "ok"; }, (e) => { window.__seen.fetch = "blocked: " + e.message; });
window.addEventListener("message", (e) => {
  const port = e.ports && e.ports[0];
  if (!port || !e.data || e.data.type !== "hivemind-view:port") return;
  port.start();
  port.postMessage({ type: "ready", v: 1 });
  // Dock the first tile on the right half, so a terminal is live while we spin.
  let W = 0, H = 0;
  port.onmessage = (m) => {
    const d = m.data || {};
    if (d.type === "hello") { W = d.viewport.w; H = d.viewport.h; }
    if (d.type === "resize") { W = d.w; H = d.h; }
    if (d.type === "structure" && d.tiles[0]) port.postMessage({ type: "surfaceRects", rects: [{ tileId: d.tiles[0].id, x: Math.round(W / 2), y: 0, w: Math.round(W / 2), h: H }] });
  };
  // Two loops: a rAF burner (what a runaway renderer looks like; under xvfb an
  // out-of-process frame's rAF runs at ~1-2 fps, so alone it barely registers)
  // and a timer burner that pegs the core no matter how rAF is throttled.
  // Both yield between bursts, so the port keeps working.
  window.__burns = { frame: 0, timer: 0 };
  const burnFrame = () => { window.__burns.frame++; const t = performance.now(); while (performance.now() - t < 40) { /* spin */ } requestAnimationFrame(burnFrame); };
  requestAnimationFrame(burnFrame);
  const burnTimer = () => { window.__burns.timer++; const t = performance.now(); while (performance.now() - t < 40) { /* spin */ } setTimeout(burnTimer, 0); };
  setTimeout(burnTimer, 0);
});
