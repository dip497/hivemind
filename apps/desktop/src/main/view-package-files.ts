/**
 * The pure part of serving a community view package (no Electron): the CSP every
 * plugin document gets, and the generated bootstrap page for a `.js` entry; which
 * file a request may read, and its type, are `@hivemind/core/view-files`'.
 * Unit-tested (view-package-files.test.ts); view-packages.ts wires it to the
 * `hm-view://` protocol handler.
 */
import { randomBytes } from "node:crypto";
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
