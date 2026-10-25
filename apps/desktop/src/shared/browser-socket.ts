/**
 * The frames on the browser's socket to main (docs/design/browser-app-2026-10-13.md): the window's
 * IPC channels, one JSON frame each. Node-free.
 */

/** Where the socket is served. */
export const SOCKET_PATH = "/socket";
/** Where the page trades the token from its link for the cookie. */
export const SESSION_PATH = "/session";
/** Where the page keeps the token for the socket's first frame: storage scoped to this origin. */
export const TOKEN_KEY = "hive-token";

export type TabFrame =
  | { t: "auth"; token: string }
  | { t: "invoke"; id: number; ch: string; args: unknown[] }
  | { t: "send"; ch: string; args: unknown[] };

export type MainFrame =
  | { t: "hello"; channels: string[]; platform: string; viewsKey: string }
  | { t: "result"; id: number; value?: unknown; error?: string }
  | { t: "event"; ch: string; args: unknown[] };

/** Closed for a token that is missing or not this launch's. */
export const CLOSE_UNAUTHORIZED = 4401;

/** The app's own schemes (§11), which a tab reaches as paths on the same server. */
export const SCHEMES = ["hm-view", "hm-plugin", "hm-media", "hivemedia"] as const;
/** Loaded by a sandboxed frame, whose requests carry no cookie: its paths carry the views key. */
export const KEYED_SCHEME = "hm-view";

/** The path a tab serves the view at `hm-view://<host>/` under: `/hm-view/<key>/<host>/`. */
export function viewBase(host: string, viewsKey: string): string {
  return `/${KEYED_SCHEME}/${viewsKey}/${host}/`;
}

/** Where a tab loads `url`: `<scheme>://<host>/<path>` at `/<scheme>/<host>/<path>`, a view's with
 *  the views key before its host (`viewBase`). Any other URL is loaded as it is. */
export function tabUrl(url: string, viewsKey: string): string {
  const m = /^([a-z-]+):\/\/([^/?#]*)\/?(.*)$/.exec(url);
  if (!m || !(SCHEMES as readonly string[]).includes(m[1]!)) return url;
  return m[1] === KEYED_SCHEME ? `${viewBase(m[2]!, viewsKey)}${m[3]}` : `/${m[1]}/${url.slice(m[1]!.length + 3)}`;
}

/** The scheme URL a tab's path names, and the views key it carries; null for any other path. */
export function schemeOf(pathname: string, search: string): { scheme: string; url: string; key: string | null } | null {
  const m = /^\/([a-z-]+)\/(.+)$/.exec(pathname);
  if (!m || !(SCHEMES as readonly string[]).includes(m[1]!)) return null;
  const scheme = m[1]!;
  let rest = m[2]!;
  let key: string | null = null;
  if (scheme === KEYED_SCHEME) {
    const at = rest.indexOf("/");
    if (at < 0) return null;
    key = rest.slice(0, at);
    rest = rest.slice(at + 1);
  }
  return { scheme, url: `${scheme}://${rest}${search}`, key };
}
