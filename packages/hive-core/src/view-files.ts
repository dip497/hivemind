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

export const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".wasm": "application/wasm",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
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

/** Where a view is served (`hm-view://<host>`, `ownFiles`; a path of its own in a browser tab) and
 *  whether it may `fetch` there: only a view whose manifest says `"files": true`. */
export interface ViewAddress { at: string; fetch: boolean }

/** The CSP every plugin document gets. No network: `fetch` and XHR reach the view's own files at
 *  `own.at` when `own.fetch`, and nothing else. No frames, objects, nothing from any other scheme.
 *  A form fires its submit event (the frame allows forms) and form-action 'none' sends it nowhere.
 *  Scripts come from the package; the only inline one that runs is the SDK's import map, which
 *  carries THIS response's nonce, so an inline script in a plugin's own page does not run; ship it
 *  as a `.js` file instead.
 *
 *  Scripts, styles, pictures, fonts and media come from the view's own address, `own.at`, and no
 *  other view's. Only where no address is known (a phone's web view, which serves one view per
 *  origin) is it 'self' and anything on `hm-view:`. */
export function pluginCsp(nonce: string, own?: ViewAddress): string {
  const from = own ? own.at : `'self' ${VIEW_SCHEME}:`;
  return [
    "default-src 'none'",
    `script-src ${from} 'nonce-${nonce}' 'wasm-unsafe-eval'`,
    `style-src ${from} 'unsafe-inline'`,
    `img-src ${from} data: blob:`,
    `font-src ${from} data:`,
    `media-src ${from} data: blob:`,
    "worker-src blob:",
    `connect-src ${own?.fetch ? own.at : "'none'"}`,
    "frame-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

/** A view's own address, `hm-view://<host>`: its origin in the app, and no other view's. `'self'`
 *  is not enough: in a browser tab every view is a path on one server. */
export function ownFiles(id: string): string {
  return `${VIEW_SCHEME}://${viewHost(id)}`;
}

/** `csp` with the view's own address (`hm-view://<host>`, in every source list that names it) at
 *  `at` instead: a browser tab serves a view under a path of its own (`/hm-view/<key>/<host>/`),
 *  which only the server answering the tab knows. */
export function withOwnFiles(csp: string, at: string): string {
  return csp.replace(new RegExp(`${VIEW_SCHEME}://[^\\s;]+`, "g"), at);
}

export function newNonce(): string {
  return randomBytes(16).toString("base64");
}

/** A `.html` entry is loaded as-is; a `.js` entry through a generated page. The host is the
 *  view's own origin: its id, or `owner--name` for `@owner/name`, which a hostname cannot hold. */
export function entryUrl(id: string, entry: string): string {
  return entryUrlAt(viewHost(id), entry);
}

/** The address of a page whose entry is `entry`, served from origin `host` (a view's, or a live
 *  wallpaper's, whose id is no hostname). */
export function entryUrlAt(host: string, entry: string): string {
  return entry.endsWith(".js") ? `${VIEW_SCHEME}://${host}/${ENTRY_PAGE}?js=${encodeURIComponent(entry)}` : `${VIEW_SCHEME}://${host}/${entry}`;
}

/** The page a screen elsewhere loads to show a view whose manifest's entry is `entry`: the entry
 *  itself when it is a page, else the generated page that runs it (`serveViewFile`). */
export function pageOf(entry: string): string {
  return entry.endsWith(".js") ? ENTRY_PAGE : entry;
}

/** Put the SDK's import map first in a plugin document, so any module script after it can
 *  import `@hivemind/view-sdk`. It carries the nonce; the page's own inline scripts still don't.
 *  The SDK is named from `page`, the document's path in the package: a view is served at an
 *  origin's root in the app and under a path in a browser tab. */
export function withImportMap(html: string, nonce: string, page: string): string {
  const up = page.split("/").length - 1;
  const map = JSON.stringify({ imports: { "@hivemind/view-sdk": `${up ? "../".repeat(up) : "./"}${SDK_PATH}` } });
  const tag = `<script type="importmap" nonce="${nonce}">${map}</script>`;
  const head = html.match(/<head\b[^>]*>/i);
  return head ? html.replace(head[0], head[0] + tag) : tag + html;
}

/** The bootstrap page for a `.js` entry: one module script, laid out at the width of the screen it
 *  is on (a phone's web view lays a page that says nothing of it out 980 pixels wide). Null when
 *  `js` is not a plain relative `.js` path. The script carries no nonce: a module's imports inherit
 *  its nonce, which would let the view import any address at all; without one, every import is
 *  held to the view's own address. */
export function entryPage(js: string): string | null {
  if (!/^[\w.-]+(?:\/[\w.-]+)*\.js$/.test(js) || js.split("/").includes("..")) return null;
  // No overflow:hidden: an Android web view can give the body no height, which would clip the page.
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{margin:0;height:100%;background:transparent}</style></head><body><script type="module" src="./${js}"></script></body></html>`;
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
 *  Each with a nonce of its own, which its policy names, and `own`, the view's address and whether
 *  it may fetch there (`pluginCsp`). */
export async function serveViewFile(dir: string, rel: string, o: { js: string | null; sdk(): Promise<string>; own?: ViewAddress }): Promise<ServedViewFile> {
  const nonce = newNonce();
  const csp = pluginCsp(nonce, o.own);
  if (rel === ENTRY_PAGE) {
    const html = entryPage(o.js ?? "");
    return html === null ? { status: 400 } : { status: 200, type: mimeFor(ENTRY_PAGE), csp, text: withImportMap(html, nonce, ENTRY_PAGE) };
  }
  if (rel === SDK_PATH) return { status: 200, type: mimeFor(SDK_PATH), csp, text: await o.sdk() };
  const file = resolvePackageFile(dir, rel);
  if (file.status !== 200) return file;
  if (/\.html?$/i.test(file.abs)) return { status: 200, type: mimeFor(ENTRY_PAGE), csp, text: withImportMap(await readFile(file.abs, "utf8"), nonce, rel) };
  return { status: 200, type: mimeFor(file.abs), csp, file: file.abs };
}
