/**
 * Hivemind Control Plane (HCP) wire protocol: JSON-RPC 2.0, one message per line, over a 0600
 * unix socket (spec/wire-protocol.md).
 *
 *   - Clients (`hive ctl`, an agent plugin's scripts, the pi extension) call `initialize`
 *     with the capability token once per connection, then make requests.
 *   - A hook reports with the `agent.event` notification and disconnects. It needs no token:
 *     the socket is the owner's alone, and an event is a fact, not a command.
 *   - Streams (`agent.stream/subscribe`, `status/subscribe`) answer with a result, then send
 *     notifications until unsubscribed or disconnected.
 */

export const HCP_VERSION = 2;

export type RpcId = string | number;
export type RpcRequest = { jsonrpc: "2.0"; id: RpcId; method: string; params?: unknown };
export type RpcNotification = { jsonrpc: "2.0"; method: string; params?: unknown };
export type RpcResponse =
  | { jsonrpc: "2.0"; id: RpcId | null; result: unknown }
  | { jsonrpc: "2.0"; id: RpcId | null; error: { code: number; message: string; data?: { code: HcpErrorCode } } };

/** JSON-RPC's reserved codes, and the one server-defined code that carries ours in `data.code`. */
export const RPC = { parse: -32700, invalid: -32600, method: -32601, hcp: -32000 } as const;

export type HcpErrorCode =
  | "BAD_REQUEST"
  | "UNKNOWN_METHOD"
  | "UNAUTHORIZED"
  | "APP_NO_RENDERER"
  | "RATE_LIMITED"
  | "DEPTH_EXCEEDED"
  | "TILE_NOT_FOUND"
  /** Something else the caller named (a frame) is not there. */
  | "NOT_FOUND"
  | "TIMEOUT"
  /** The target provider lacks the capability the verb needs (no turn signal →
   *  nothing to read/gather; no permission system → nothing to supervise). */
  | "UNSUPPORTED"
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
