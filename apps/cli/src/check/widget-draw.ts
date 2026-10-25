/** A widget's code run as the app runs it: in a worker, after the same `hive` (WIDGET_PRELUDE),
 *  told it started, and its first drawing checked as the app checks it. `hive.hm` reaches a
 *  view-SDK fake host.
 *
 *  The worker has no environment, and inside it the widget runs in a context of its own with
 *  nothing of the worker's: no Bun, process, require, import() or network, as the app's widget
 *  worker has none. Only text crosses: what it posts leaves as JSON, and what it is told, its
 *  timers firing included, arrives as JSON its own context parses. */
import { drawingProblem, WIDGET_PRELUDE } from "@hivemind/core/widget-api";
import { resolveSettings } from "@hivemind/core/plugin-settings";
import { tintProblem, widgetTree, type WidgetPackage } from "@hivemind/core/widget-format";
import { fakeHost } from "@hivemind/view-sdk/testing";
import path from "node:path";
import { placeIn, type Problem } from "./problem.js";

const FIRST_DRAW_MS = 1500;

/** Defined inside the widget's context, by its own code: the only way in and out is text. */
const BRIDGE = `
var __out = [], __timers = {}, __n = 0;
var __send = function (m) { __out.push(JSON.stringify(m)); };
var self = globalThis;
var postMessage = function (m) { __send({ t: "msg", m: m }); };
var __err = function (e, how) {
  __send({ t: "err", how: how, message: e && e.message !== undefined ? String(e.message) : String(e), name: e && e.name ? String(e.name) : "", stack: e && e.stack ? String(e.stack) : "" });
};
var console = { log: function () {}, info: function () {}, debug: function () {}, warn: function () {}, error: function (e) { __err(e, "it threw: "); } };
var setTimeout = function (f, ms) { var id = ++__n; __timers[id] = f; __send({ t: "timer", id: id, ms: Number(ms) || 0 }); return id; };
var setInterval = function (f, ms) { var id = ++__n; __timers[id] = f; __send({ t: "timer", id: id, ms: Number(ms) || 0, every: true }); return id; };
var clearTimeout = function (id) { delete __timers[id]; };
var clearInterval = clearTimeout;
var __fire = function (id, every) {
  var f = __timers[id];
  if (!every) delete __timers[id];
  if (typeof f === "function") { try { f(); } catch (e) { __err(e, "a timer of it threw: "); } }
};
var __deliver = function (json) { if (typeof self.onmessage === "function") self.onmessage({ data: JSON.parse(json) }); };
var __drain = function () { return JSON.stringify(__out.splice(0)); };
`;

/** The worker: it makes the context, runs the widget in it, and relays text. */
const WORKER = `
const vm = require("node:vm");
let ctx = null;
const inside = (code) => vm.runInContext(code, ctx);
const drain = () => {
  if (!ctx) return;
  let out;
  try { out = JSON.parse(String(inside("__drain()"))); } catch { return; }
  for (const s of Array.isArray(out) ? out : []) {
    let m; try { m = JSON.parse(String(s)); } catch { continue; }
    if (m.t === "timer") {
      const fire = () => { try { inside("__fire(" + Number(m.id) + ", " + (m.every ? "true" : "false") + ")"); } catch {} drain(); };
      if (m.every) setInterval(fire, Math.max(10, Number(m.ms) || 0)); else setTimeout(fire, Number(m.ms) || 0);
    } else postMessage(JSON.stringify(m));
  }
};
const failed = (e, how) => postMessage(JSON.stringify({ t: "err", how, message: String(e && e.message !== undefined ? e.message : e), name: String((e && e.name) || ""), stack: String((e && e.stack) || "") }));
process.on("unhandledRejection", (e) => failed(e, "a promise of it failed unheard: "));
setInterval(drain, 10);
self.onmessage = (e) => {
  const m = e.data;
  if (m.type === "run") {
    ctx = vm.createContext(Object.create(null));
    inside(m.bridge);
    vm.runInContext(m.prelude, ctx, { filename: "hive.js" });
    try { vm.runInContext(m.code, ctx, { filename: m.filename }); } catch (err) { failed(err, "running it threw: "); return; }
    inside("__deliver(" + JSON.stringify(m.init) + ")");
  } else if (m.type === "deliver" && ctx) {
    inside("__deliver(" + JSON.stringify(m.json) + ")");
  }
  drain();
};
`;

export async function drawWidget(w: WidgetPackage, dir: string): Promise<Problem[]> {
  const problems: Problem[] = [];
  if (w.draw !== undefined) {
    // Its tint as it is drawn: each "$options.<id>" being that option's default.
    const why = drawingProblem(w.draw, "its draw") ?? tintProblem(widgetTree({ id: w.id, widget: w.id }, w, undefined), "its draw");
    if (why) problems.push({ step: "draw", file: "widget.json", message: why });
  }
  if (!w.code) return problems;

  const fake = fakeHost({ pluginId: w.id, capabilities: w.permissions as never });
  const hm = await fake.connect();
  const worker = new Worker(URL.createObjectURL(new Blob([WORKER], { type: "application/javascript" })), { env: {} } as WorkerOptions);
  const renders: unknown[] = [];
  const deliver = (data: unknown) => worker.postMessage({ type: "deliver", json: JSON.stringify(data) });
  const call = (m: { req?: number; path?: unknown; args?: unknown }) => {
    const args = (Array.isArray(m.args) ? m.args : []).map((a) => (a && typeof a === "object" && "__fn" in a ? (...x: unknown[]) => deliver({ type: "hm-cb", fn: (a as { __fn: number }).__fn, args: x }) : a));
    Promise.resolve().then(() => {
      let at: unknown = hm, owner: unknown = hm;
      for (const k of Array.isArray(m.path) ? m.path.map(String) : []) { owner = at; at = (at as Record<string, unknown> | undefined)?.[k]; }
      return typeof at === "function" ? (at as (...x: unknown[]) => unknown).apply(owner, args) : at;
    }).then((value) => deliver({ type: "hm-reply", req: m.req, ok: true, value }), (e: unknown) => deliver({ type: "hm-reply", req: m.req, ok: false, error: e instanceof Error ? e.message : String(e) }));
  };
  worker.onmessage = (e: MessageEvent) => {
    let m: { t?: string; m?: { type?: string; tree?: unknown }; how?: string; message?: string; name?: string; stack?: string };
    try { m = JSON.parse(String(e.data)); } catch { return; }
    if (m.t === "err") {
      const name = m.name && m.name !== "Error" ? `${m.name}: ` : "";
      problems.push({ step: "draw", message: `${m.how ?? ""}${name}${m.message ?? ""}`, ...placeIn(m.stack ?? "", dir) });
    } else if (m.t === "msg" && m.m?.type === "render") renders.push(m.m.tree);
    else if (m.t === "msg" && m.m?.type === "hm-call") call(m.m as never);
  };
  try {
    worker.postMessage({
      type: "run", bridge: BRIDGE, prelude: WIDGET_PRELUDE, code: await Bun.file(path.join(dir, "widget.js")).text(), filename: path.join(dir, "widget.js"),
      init: JSON.stringify({ type: "init", state: undefined, options: resolveSettings(w.options, {}), reducedMotion: false }),
    });
    const until = Date.now() + FIRST_DRAW_MS;
    while (!renders.length && !problems.length && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    if (!renders.length && !problems.length && w.draw === undefined) {
      problems.push({ step: "draw", file: "widget.js", message: `it drew nothing within ${FIRST_DRAW_MS / 1000} s of starting: call hive.render() on "start"` });
    }
    if (renders.length) {
      const why = drawingProblem(renders[0]) ?? tintProblem(renders[0]);
      if (why) problems.push({ step: "draw", file: "widget.js", message: `its first drawing: ${why}` });
    }
    return problems;
  } finally {
    worker.terminate();
    fake.close();
  }
}
