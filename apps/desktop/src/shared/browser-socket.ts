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
  | { t: "hello"; channels: string[]; platform: string }
  | { t: "result"; id: number; value?: unknown; error?: string }
  | { t: "event"; ch: string; args: unknown[] };

/** Closed for a token that is missing or not this launch's. */
export const CLOSE_UNAUTHORIZED = 4401;
