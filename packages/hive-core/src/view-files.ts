/**
 * A community view package's files as they are served: which file a request may read, and what
 * type it is; the CSP every view document gets; the generated page for a `.js` entry; and the
 * SDK's import map. The app's `hm-view://` handler serves them to the view's sandboxed iframe, and
 * a device serves them to the person's phone (`view.file`, P8), the same through `serveViewFile`.
 */
import path from "node:path";
import { randomBytes } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { viewHost } from "@hivemind/view-sdk/manifest";

export const VIEW_SCHEME = "hm-view";
/** The page that runs a `.js` entry, generated for each view. */
export const ENTRY_PAGE = "__entry.html";
/** The SDK the app serves on every view origin, so a view never bundles its own copy. */
export const SDK_PATH = "__sdk.js";
const IMPORT_MAP = JSON.stringify({ imports: { "@hivemind/view-sdk": `/${SDK_PATH}` } });

export const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".wasm": "application/wasm",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".mp4": "video/mp4", ".webm": "video/webm",
  ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".txt": "text/plain; charset=utf-8",
};

export function mimeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

export type FileResolution = { status: 200; abs: string } | { status: 403 | 404 };

/** The file a request for `rel` inside package `dir` may read. Containment is
 *  checked on the RESOLVED path (symlinks followed): a link inside a
 *  downloaded package that points outside it is a 403, not a read. */
export function resolvePackageFile(dir: string, rel: string): FileResolution {
  let root: string;
  try { root = realpathSync(dir); } catch { return { status: 404 }; }
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return { status: 403 };
  if (!existsSync(abs)) return { status: 404 };
  let real: string;
  try { real = realpathSync(abs); } catch { return { status: 404 }; }
  if (real !== root && !real.startsWith(root + path.sep)) return { status: 403 };
  if (!statSync(real).isFile()) return { status: 404 };
  return { status: 200, abs: real };
}

/** The CSP every plugin document gets. No network (connect-src 'none'), no
 *  frames, forms, objects, nothing from any other scheme. Scripts come from
 *  the package or carry THIS response's nonce — which only the bootstrap page
 *  we generate ever has, so an inline script in a plugin's own page does not
 *  run; ship it as a `.js` file instead. The package is the view's own origin
 *  ('self': where a phone's web view serves it, `https:` there) and anything
 *  on `hm-view:` (the app's iframe, whose sandboxed origin is opaque). */
export function pluginCsp(nonce: string): string {
  const own = `'self' ${VIEW_SCHEME}:`;
  return [
    "default-src 'none'",
    `script-src ${own} 'nonce-${nonce}' 'wasm-unsafe-eval'`,
    `style-src ${own} 'unsafe-inline'`,
    `img-src ${own} data: blob:`,
    `font-src ${own} data:`,
    `media-src ${own} data: blob:`,
    "worker-src blob:",
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

export function newNonce(): string {
  return randomBytes(16).toString("base64");
}

/** A `.html` entry is loaded as-is; a `.js` entry through a generated page. The host is the
 *  view's own origin: its id, or `owner--name` for `@owner/name`, which a hostname cannot hold. */
export function entryUrl(id: string, entry: string): string {
  const host = viewHost(id);
  return entry.endsWith(".js") ? `${VIEW_SCHEME}://${host}/${ENTRY_PAGE}?js=${encodeURIComponent(entry)}` : `${VIEW_SCHEME}://${host}/${entry}`;
}

/** The page a screen elsewhere loads to show a view whose manifest's entry is `entry`: the entry
 *  itself when it is a page, else the generated page that runs it (`serveViewFile`). */
export function pageOf(entry: string): string {
  return entry.endsWith(".js") ? ENTRY_PAGE : entry;
}

/** Put the SDK's import map first in a plugin document, so any module script after it can
 *  import `@hivemind/view-sdk`. It carries the nonce; the page's own inline scripts still don't. */
export function withImportMap(html: string, nonce: string): string {
  const tag = `<script type="importmap" nonce="${nonce}">${IMPORT_MAP}</script>`;
  const head = html.match(/<head\b[^>]*>/i);
  return head ? html.replace(head[0], head[0] + tag) : tag + html;
}

/** The bootstrap page for a `.js` entry: one module script, tagged with the
 *  response's nonce. Null when `js` is not a plain relative `.js` path. */
export function entryPage(js: string, nonce: string): string | null {
  if (!/^[\w.-]+(?:\/[\w.-]+)*\.js$/.test(js) || js.split("/").includes("..")) return null;
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}</style></head><body><script type="module" nonce="${nonce}" src="./${js}"></script></body></html>`;
}

/** What a request for a view's file is served, under `csp`, the policy the response carries: text
 *  made here (the SDK, the entry page, a page of the view's with the import map first), or one of
 *  its files as it is, by its real path, for the caller to read or stream; or why not (400: the
 *  entry page for no plain relative `.js`; 403, 404: `resolvePackageFile`'s). */
export type ServedViewFile =
  | { status: 200; type: string; csp: string; text: string }
  | { status: 200; type: string; csp: string; file: string }
  | { status: 400 | 403 | 404 };

/** Serve `rel` of the view package at `dir` as every screen is served it: `__sdk.js` is the SDK
 *  (`sdk()`, the build this device serves), `__entry.html` the page that runs the `.js` entry `js`,
 *  a page of the view's gets the SDK's import map first, and anything else is the file as it is.
 *  Each with a nonce of its own, which its policy names. */
export async function serveViewFile(dir: string, rel: string, o: { js: string | null; sdk(): Promise<string> }): Promise<ServedViewFile> {
  const nonce = newNonce();
  const csp = pluginCsp(nonce);
  if (rel === ENTRY_PAGE) {
    const html = entryPage(o.js ?? "", nonce);
    return html === null ? { status: 400 } : { status: 200, type: mimeFor(ENTRY_PAGE), csp, text: withImportMap(html, nonce) };
  }
  if (rel === SDK_PATH) return { status: 200, type: mimeFor(SDK_PATH), csp, text: await o.sdk() };
  const file = resolvePackageFile(dir, rel);
  if (file.status !== 200) return file;
  if (/\.html?$/i.test(file.abs)) return { status: 200, type: mimeFor(ENTRY_PAGE), csp, text: withImportMap(await readFile(file.abs, "utf8"), nonce) };
  return { status: 200, type: mimeFor(file.abs), csp, file: file.abs };
}
