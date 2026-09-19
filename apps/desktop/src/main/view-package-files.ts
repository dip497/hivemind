/**
 * The pure part of serving a community view package (no Electron): which file
 * a request may read, the CSP every plugin document gets, and the generated
 * bootstrap page for a `.js` entry. Unit-tested (view-package-files.test.ts);
 * view-packages.ts wires it to the `hm-view://` protocol handler.
 */
import path from "node:path";
import { randomBytes } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { viewHost } from "@hivemind/view-sdk/manifest";

export const VIEW_SCHEME = "hm-view";

/** The CSP every plugin document gets. No network (connect-src 'none'), no
 *  frames, forms, objects, nothing from any other scheme. Scripts come from
 *  the package (`hm-view:`) or carry THIS response's nonce — which only the
 *  bootstrap page we generate ever has, so an inline script in a plugin's own
 *  page does not run; ship it as a `.js` file instead. */
export function pluginCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src ${VIEW_SCHEME}: 'nonce-${nonce}' 'wasm-unsafe-eval'`,
    `style-src ${VIEW_SCHEME}: 'unsafe-inline'`,
    `img-src ${VIEW_SCHEME}: data: blob:`,
    `font-src ${VIEW_SCHEME}: data:`,
    `media-src ${VIEW_SCHEME}: data: blob:`,
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

/** A `.html` entry is loaded as-is; a `.js` entry through a generated page. The host is the
 *  view's own origin: its id, or `owner--name` for `@owner/name`, which a hostname cannot hold. */
export function entryUrl(id: string, entry: string): string {
  const host = viewHost(id);
  return entry.endsWith(".js") ? `${VIEW_SCHEME}://${host}/__entry.html?js=${encodeURIComponent(entry)}` : `${VIEW_SCHEME}://${host}/${entry}`;
}

export const ENTRY_PAGE = "__entry.html";
/** The SDK the app serves on every view origin, so a view never bundles its own copy. */
export const SDK_PATH = "__sdk.js";
const IMPORT_MAP = JSON.stringify({ imports: { "@hivemind/view-sdk": `/${SDK_PATH}` } });

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
