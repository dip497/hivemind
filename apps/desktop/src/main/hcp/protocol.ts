/**
 * Hivemind Control Plane (HCP) wire protocol. NDJSON over a 0600 unix socket —
 * one JSON object per line, `t` discriminator. Same house style as the pty
 * daemon (pty-protocol.ts) and plan-bridge.
 *
 * Two kinds of client:
 *   - DRIVERS (the MCP server, a CLI) open a connection and issue `req`s, each
 *     correlated by `id`, getting one `res` back. They may `sub`scribe to event
 *     topics (Phase 2: agent.stream) and get `evt`s.
 *   - HOOKS (the injected Stop hook) fire one `event` and disconnect — no reply.
 *
 * Every driver `req` carries the capability `token` (minted by main, injected
 * into spawned agents' env). Hook `event`s are unauthenticated by token but the
 * 0600 socket already gates them to same-uid processes.
 */

export const HCP_VERSION = 1;

/** Driver → server. */
export type HcpReq = {
  t: "req";
  id: string;
  method: string;
  params?: unknown;
  token?: string;
};
export type HcpSub = { t: "sub"; id: string; topic: string; params?: unknown; token?: string };
export type HcpUnsub = { t: "unsub"; id: string };
/** Hook → server, fire-and-forget (e.g. the Stop hook reporting a finished turn). */
export type HcpEventIn = { t: "event"; topic: string; data?: unknown };

export type HcpClientMsg = HcpReq | HcpSub | HcpUnsub | HcpEventIn;

/** Server → driver. */
export type HcpRes =
  | { t: "res"; id: string; ok: true; result: unknown }
  | { t: "res"; id: string; ok: false; error: { code: HcpErrorCode; message: string } };
export type HcpEvtOut = { t: "evt"; subId: string; topic: string; data: unknown };
export type HcpHello = { t: "hello"; version: number; rendererUp: boolean };

export type HcpServerMsg = HcpRes | HcpEvtOut | HcpHello;

export type HcpErrorCode =
  | "BAD_REQUEST"
  | "UNKNOWN_METHOD"
  | "UNAUTHORIZED"
  | "APP_NO_RENDERER"
  | "RATE_LIMITED"
  | "DEPTH_EXCEEDED"
  | "TILE_NOT_FOUND"
  | "TIMEOUT"
  | "INTERNAL";

export class HcpError extends Error {
  constructor(public code: HcpErrorCode, message: string) {
    super(message);
    this.name = "HcpError";
  }
}

/** Max accepted line length — a runaway/garbage client can't OOM us (1 MiB). */
export const HCP_MAX_LINE = 1 << 20;

/** Split a growing buffer on newlines, returning complete lines + the remainder.
 *  Throws if a single line exceeds HCP_MAX_LINE (caller should drop the conn). */
export function takeLines(buf: string): { lines: string[]; rest: string } {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === "\n") {
      lines.push(buf.slice(start, i));
      start = i + 1;
    }
  }
  const rest = buf.slice(start);
  if (rest.length > HCP_MAX_LINE) throw new HcpError("BAD_REQUEST", "line too long");
  return { lines, rest };
}
