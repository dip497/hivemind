// A widget's code reads `hive.hm`'s values from its first line, before the window has sent them:
// each is already the shape its declarations give (`capabilities` an array), and `hive.on("hm")`
// tells the code when the real ones arrive.
import { afterEach, expect, test } from "bun:test";
import { WIDGET_PRELUDE } from "./widget-api.js";

const workers: Worker[] = [];
afterEach(() => { for (const w of workers.splice(0)) w.terminate(); });

/** The widget's code running as the app runs it: the prelude, then its code, in a worker. */
function run(code: string): { worker: Worker; next: () => Promise<{ type: string; tree?: unknown }> } {
  const worker = new Worker(URL.createObjectURL(new Blob([WIDGET_PRELUDE, code], { type: "text/javascript" })));
  workers.push(worker);
  const queue: Array<{ type: string; tree?: unknown }> = [];
  const waiting: Array<(m: { type: string; tree?: unknown }) => void> = [];
  worker.onmessage = (e) => { const w = waiting.shift(); if (w) w(e.data); else queue.push(e.data); };
  worker.onerror = (e) => { const w = waiting.shift(); const m = { type: "error", tree: e.message }; if (w) w(m); else queue.push(m); };
  const next = () => new Promise<{ type: string; tree?: unknown }>((resolve, reject) => {
    const m = queue.shift();
    if (m) { resolve(m); return; }
    const timer = setTimeout(() => reject(new Error("the widget sent nothing")), 3000);
    waiting.push((x) => { clearTimeout(timer); resolve(x); });
  });
  return { worker, next };
}

test("hive.hm.capabilities is an array from the first draw, and hive.on(\"hm\") hears the window's", async () => {
  const { worker, next } = run(`
    const draw = () => hive.render({ type: "text", text: hive.hm.capabilities.includes("workspace:spawn") ? "can spawn" : "cannot spawn" });
    hive.on("hm", draw);
    draw();
  `);
  expect(await next()).toEqual({ type: "render", tree: { type: "text", text: "cannot spawn" } });
  worker.postMessage({ type: "hm-values", values: { capabilities: ["workspace:spawn"], features: [], settings: {} } });
  expect(await next()).toEqual({ type: "render", tree: { type: "text", text: "can spawn" } });
});

test("a widget is told at its start that the person asked for less motion, and hears when that changes", async () => {
  const { worker, next } = run(`
    const draw = () => hive.render({ type: "text", text: hive.reducedMotion ? "still" : "moving" });
    hive.on("start", draw);
    hive.on("motion", draw);
  `);
  worker.postMessage({ type: "init", state: null, options: {}, reducedMotion: true });
  expect(await next()).toEqual({ type: "render", tree: { type: "text", text: "still" } });
  worker.postMessage({ type: "motion", payload: false });
  expect(await next()).toEqual({ type: "render", tree: { type: "text", text: "moving" } });
});
