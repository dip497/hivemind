/**
 * What a tool plugin's code breaks in the app's page, told to its tiles: an error it throws and
 * nothing catches, a promise of its that rejects unheard, and anything of its the page's security
 * policy blocks (a frame of a site that is not this machine). A tool runs in the app's own page,
 * so these land on the window; each is put on the tile it happened in, else on every tile of the
 * plugin whose `hm-plugin://owner--name/` code it came from.
 */

const PLUGIN_CODE = /hm-plugin:\/\/([a-z0-9][a-z0-9-]*--[a-z0-9][a-z0-9-]*)\//;

/** The plugin folder (`owner--name`) the first of `sources` names, if any does. */
export function pluginFolderIn(sources: ReadonlyArray<string | null | undefined>): string | null {
  for (const s of sources) {
    const m = s ? PLUGIN_CODE.exec(s) : null;
    if (m) return m[1]!;
  }
  return null;
}

/** A failure on the window: why, and what says whose it is. */
export interface PageFailure { why: string; sources: Array<string | null | undefined>; blocked?: string }

const stackOf = (x: unknown): string | undefined => (x instanceof Error ? x.stack : typeof x === "object" && x && "stack" in x ? String((x as { stack: unknown }).stack) : undefined);
const messageOf = (x: unknown): string => (x instanceof Error ? x.message : typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })());

export function errorFailure(e: { message?: string; filename?: string; error?: unknown }): PageFailure {
  return { why: e.error !== undefined && e.error !== null ? messageOf(e.error) : e.message || "an error", sources: [e.filename, stackOf(e.error)] };
}

export function rejectionFailure(e: { reason?: unknown }): PageFailure {
  return { why: `a promise rejected: ${messageOf(e.reason)}`, sources: [stackOf(e.reason)] };
}

export function policyFailure(e: { blockedURI?: string; effectiveDirective?: string; sourceFile?: string }): PageFailure {
  const what = e.blockedURI ? e.blockedURI : "something";
  const loopback = e.effectiveDirective === "frame-src" ? "; a tool can frame only this machine (http://127.0.0.1 or http://localhost)" : "";
  return { why: `the app's security policy blocked ${what} (${e.effectiveDirective ?? "unknown"})${loopback}`, sources: [e.sourceFile], ...(e.blockedURI ? { blocked: e.blockedURI } : {}) };
}

interface Watch { folder: string; element: () => Element | null; fail: (why: string) => void }
const watching = new Set<Watch>();

function report(target: EventTarget | null, f: PageFailure): void {
  const el = typeof Element !== "undefined" && target instanceof Element ? target : null;
  let hit = el ? [...watching].filter((w) => w.element()?.contains(el)) : [];
  // A blocked frame is reported on the document: whose it is, is whose frame asks for that address.
  if (!hit.length && f.blocked) hit = [...watching].filter((w) => [...(w.element()?.querySelectorAll("iframe") ?? [])].some((frame) => frame.src.startsWith(f.blocked!)));
  if (!hit.length) {
    const folder = pluginFolderIn(f.sources);
    hit = folder ? [...watching].filter((w) => w.folder === folder) : [];
  }
  for (const w of hit) w.fail(f.why);
}

let listening = false;
function listen(): void {
  if (listening) return;
  listening = true;
  window.addEventListener("error", (e) => report(null, errorFailure(e)));
  window.addEventListener("unhandledrejection", (e) => report(null, rejectionFailure(e)));
  // Fired at the element whose load was blocked, else at the document.
  document.addEventListener("securitypolicyviolation", (e) => report(e.target, policyFailure(e)), true);
}

/** Tell `fail` what plugin `folder`'s code breaks, or what breaks inside `element`; until undone. */
export function watchToolFailures(w: Watch): () => void {
  listen();
  watching.add(w);
  return () => { watching.delete(w); };
}
