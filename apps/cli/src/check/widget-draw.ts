/** A widget's code run as the app runs it, after the same `hive` (WIDGET_PRELUDE), told it started,
 *  and its first drawing checked as the app checks it. `hive.hm` reaches a view-SDK fake host. */
import path from "node:path";
import vm from "node:vm";
import { drawingProblem, WIDGET_PRELUDE } from "@hivemind/core/widget-api";
import { resolveSettings } from "@hivemind/core/plugin-settings";
import type { WidgetPackage } from "@hivemind/core/widget-format";
import { fakeHost } from "@hivemind/view-sdk/testing";
import { thrown, type Problem } from "./problem.js";

const FIRST_DRAW_MS = 1500;

export async function drawWidget(w: WidgetPackage, dir: string): Promise<Problem[]> {
  const problems: Problem[] = [];
  if (w.draw !== undefined) {
    const why = drawingProblem(w.draw, "its draw");
    if (why) problems.push({ step: "draw", file: "widget.json", message: why });
  }
  if (!w.code) return problems;

  const file = path.join(dir, "widget.js");
  const fake = fakeHost({ pluginId: w.id, capabilities: w.permissions as never });
  const hm = await fake.connect();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const renders: unknown[] = [];
  const fail = (e: unknown, prefix: string) => problems.push(thrown("draw", e, dir, prefix));
  const guard = (fn: unknown) => (...a: unknown[]) => { try { (fn as (...x: unknown[]) => void)(...a); } catch (e) { fail(e, "a timer of it threw: "); } };
  const ctx: Record<string, unknown> = {
    console: { ...console, log() {}, info() {}, debug() {}, warn() {}, error: (...a: unknown[]) => fail(a.length === 1 && a[0] && typeof a[0] === "object" ? a[0] : a.map(String).join(" "), "it threw: ") },
    setTimeout: (fn: unknown, ms?: number, ...a: unknown[]) => { const t = setTimeout(guard(fn), ms, ...a); timers.add(t); return t; },
    setInterval: (fn: unknown, ms?: number, ...a: unknown[]) => { const t = setInterval(guard(fn), ms, ...a); timers.add(t); return t; },
    clearTimeout, clearInterval, queueMicrotask, structuredClone, fetch, URL, TextEncoder, TextDecoder, crypto, performance,
  };
  const deliver = (data: unknown) => (ctx.onmessage as ((e: { data: unknown }) => void) | undefined)?.({ data });
  ctx.self = ctx;
  ctx.globalThis = ctx;
  ctx.postMessage = (m: { type: string; tree?: unknown; req?: number; path?: string[]; args?: unknown[] }) => {
    if (m.type === "render") renders.push(m.tree);
    if (m.type !== "hm-call") return;
    const args = (m.args ?? []).map((a) => (a && typeof a === "object" && "__fn" in a ? (...x: unknown[]) => deliver({ type: "hm-cb", fn: (a as { __fn: number }).__fn, args: x }) : a));
    Promise.resolve().then(() => {
      let at: unknown = hm, self: unknown = hm;
      for (const k of m.path ?? []) { self = at; at = (at as Record<string, unknown>)[k]; }
      return typeof at === "function" ? (at as (...x: unknown[]) => unknown).apply(self, args) : at;
    }).then((value) => deliver({ type: "hm-reply", req: m.req, ok: true, value }), (e: unknown) => deliver({ type: "hm-reply", req: m.req, ok: false, error: e instanceof Error ? e.message : String(e) }));
  };
  const onRejection = (e: unknown) => fail(e, "a promise of it failed unheard: ");
  process.on("unhandledRejection", onRejection);
  try {
    vm.createContext(ctx);
    vm.runInContext(WIDGET_PRELUDE, ctx, { filename: "hive.js" });
    try {
      vm.runInContext(await Bun.file(file).text(), ctx, { filename: file });
    } catch (e) {
      fail(e, "running it threw: ");
      return problems;
    }
    deliver({ type: "init", state: undefined, options: resolveSettings(w.options, {}), reducedMotion: false });
    const until = Date.now() + FIRST_DRAW_MS;
    while (!renders.length && !problems.length && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    if (!renders.length && !problems.length && w.draw === undefined) {
      problems.push({ step: "draw", file: "widget.js", message: `it drew nothing within ${FIRST_DRAW_MS / 1000} s of starting: call hive.render() on "start"` });
    }
    if (renders.length) {
      const why = drawingProblem(renders[0]);
      if (why) problems.push({ step: "draw", file: "widget.js", message: `its first drawing: ${why}` });
    }
    return problems;
  } finally {
    for (const t of timers) clearTimeout(t);
    process.off("unhandledRejection", onRejection);
    fake.close();
  }
}
