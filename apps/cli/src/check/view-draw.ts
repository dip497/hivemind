/** A view built by its own build script, then its page loaded into a document of its HTML: its
 *  module scripts run, `@hivemind/view-sdk` is the SDK the app serves, and `connect()` reaches a
 *  view-SDK fake host, which checks everything the view sends as the app does. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseHTML } from "linkedom";
import * as viewSdk from "@hivemind/view-sdk";
import { MANIFEST_FILE, validateViewManifest } from "@hivemind/view-sdk/manifest";
import { fakeHost } from "@hivemind/view-sdk/testing";
import { thrown, type Problem } from "./problem.js";

const CONNECT_MS = 3000;

function onPath(bin: string): boolean {
  return (process.env.PATH ?? "").split(path.delimiter).some((d) => fs.existsSync(path.join(d, bin)));
}

/** Its build script run, if it has one; what went wrong, or null. */
function build(dir: string): Problem | null {
  let pkg: { scripts?: Record<string, string>; dependencies?: object; devDependencies?: object };
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")); } catch { return null; }
  if (!pkg.scripts?.build) return null;
  if ((pkg.dependencies || pkg.devDependencies) && !fs.existsSync(path.join(dir, "node_modules"))) {
    return { step: "draw", file: "package.json", message: "it is not installed: run `npm install` in its folder first" };
  }
  const r = onPath("npm")
    ? spawnSync("npm", ["run", "--silent", "build"], { cwd: dir, encoding: "utf8", timeout: 180_000 })
    : spawnSync(process.execPath, ["run", "build"], { cwd: dir, encoding: "utf8", timeout: 180_000, env: { ...process.env, BUN_BE_BUN: "1" } });
  if (r.status === 0) return null;
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim().split("\n").slice(-6).join("\n");
  return { step: "draw", file: "package.json", message: `its build failed: ${out || r.error?.message || `exit ${r.status}`}` };
}

export async function drawView(dir: string): Promise<Problem[]> {
  const built = build(dir);
  if (built) return [built];
  // What it built is the view (dist/ in a starter), when it built one.
  const root = fs.existsSync(path.join(dir, "dist", MANIFEST_FILE)) ? path.join(dir, "dist") : dir;
  const rel = (f: string) => path.relative(dir, f);
  let manifest;
  try {
    const m = validateViewManifest(JSON.parse(fs.readFileSync(path.join(root, MANIFEST_FILE), "utf8")));
    if (!m.ok) return m.errors.map((message) => ({ step: "draw", file: rel(path.join(root, MANIFEST_FILE)), message }));
    manifest = m.manifest;
  } catch (e) { return [thrown("draw", e, dir, `${rel(path.join(root, MANIFEST_FILE))}: `)]; }
  const entry = path.join(root, manifest.entry);
  if (!fs.existsSync(entry)) return [{ step: "draw", message: `its entry ${rel(entry)} is not there` }];

  const problems: Problem[] = [];
  const fail = (prefix: string) => (e: unknown) => problems.push(thrown("draw", e, dir, prefix));
  const fake = fakeHost({ pluginId: manifest.id, capabilities: manifest.permissions ?? [] });
  const dom = parseHTML(fs.readFileSync(entry, "utf8"));
  const win = new EventTarget() as EventTarget & Record<string, unknown>;
  let connected = false;
  const listen = win.addEventListener.bind(win);
  win.addEventListener = ((type: string, ...rest: Parameters<EventTarget["addEventListener"]> extends [string, ...infer R] ? R : never) => {
    listen(type, ...rest);
    if (type === "message" && !connected) { connected = true; queueMicrotask(() => fake.handshake(win)); }
  }) as EventTarget["addEventListener"];
  Object.assign(win, {
    document: dom.document, location: new URL(`hm-view://${manifest.id.replace(/^@/, "").replace("/", "--")}/${manifest.entry}`),
    innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1, navigator: globalThis.navigator,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(performance.now()), 16),
    cancelAnimationFrame: (t: ReturnType<typeof setTimeout>) => clearTimeout(t),
    parent: undefined, top: undefined,
  });
  const g = globalThis as Record<string, unknown>;
  for (const k of ["HTMLElement", "Element", "Node", "Text", "DocumentFragment", "CustomEvent", "HTMLCanvasElement", "SVGElement", "customElements", "MutationObserver"]) {
    if (!(k in g) && (dom as unknown as Record<string, unknown>)[k]) g[k] = (dom as unknown as Record<string, unknown>)[k];
  }
  for (const k of ["document", "location", "innerWidth", "innerHeight", "devicePixelRatio", "matchMedia", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) g[k] = win[k];
  g.window = win;
  win.parent = win; win.top = win;
  Bun.plugin({ name: "hivemind-view-sdk", setup(b) { b.module("@hivemind/view-sdk", () => ({ exports: { ...viewSdk }, loader: "object" })); } });

  const onError = fail("it threw: ");
  const onRejection = fail("a promise of it failed unheard: ");
  process.on("uncaughtException", onError);
  process.on("unhandledRejection", onRejection);
  try {
    const scripts = [...dom.document.querySelectorAll("script[type=module][src]")].map((s) => path.resolve(path.dirname(entry), String(s.getAttribute("src"))));
    if (!scripts.length) problems.push({ step: "draw", file: rel(entry), message: "it loads no module script: a view's code is a <script type=\"module\" src=…>" });
    // Its module may wait for the host (top-level `await connect()`): every one is started at once.
    const loads = scripts.map((s) => fs.existsSync(s) ? import(pathToFileURL(s).href).catch(fail("loading it failed: ")) : Promise.resolve(problems.push({ step: "draw", file: rel(entry), message: `it loads ${rel(s)}, which is not there` })));
    const until = Date.now() + CONNECT_MS;
    while (!fake.received.length && !problems.length && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    if (!fake.received.length && !problems.length && scripts.length) problems.push({ step: "draw", message: `it did not connect() within ${CONNECT_MS / 1000} s` });
    if (fake.received.length) {
      fake.send({ type: "structure", frames: [{ id: "f1", name: "Frame", x: 0, y: 0, w: 800, h: 600 } as never], tiles: [{ id: "t1", frameId: "f1", kind: "shell", name: "Shell" } as never] });
      await fake.settle();
      await Promise.race([Promise.all(loads), new Promise((r) => setTimeout(r, 500))]);
      await fake.settle();
    }
    for (const why of fake.refused) problems.push({ step: "draw", message: `the app would refuse what it sent: ${why}` });
    return problems;
  } finally {
    process.off("uncaughtException", onError);
    process.off("unhandledRejection", onRejection);
    fake.close();
  }
}
