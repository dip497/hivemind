/**
 * Hivemind Control Plane (HCP) wire protocol: JSON-RPC 2.0, one message per line, over a 0600
 * unix socket (spec/wire-protocol.md).
 *
 *   - Clients (`hive ctl`, an agent plugin's scripts, the pi extension) call `initialize`
 *     with the capability token once per connection, then make requests. The token says who
 *     calls: the app's own is the person at this machine, a tile's agent is given its own.
 *   - A hook reports with the `agent.event` notification and disconnects. It needs no token:
 *     the socket is the owner's alone, and an event is a fact, not a command.
 */
import type { Actor } from "@hivemind/workspace-host/intents";
import { ApiError, type ErrorCode } from "@hivemind/workspace-api/protocol";

export const HCP_VERSION = 2;

/** One request as the dispatch sees it: who made it, and whether they are still there. */
export interface HcpCall {
  /** Known from the token the connection introduced itself with. */
  actor: Actor;
  /** Aborted when the caller's connection closes: nobody waits for the answer any more. */
  signal?: AbortSignal;
}

export type RpcId = string | number;
export type RpcRequest = { jsonrpc: "2.0"; id: RpcId; method: string; params?: unknown };
export type RpcNotification = { jsonrpc: "2.0"; method: string; params?: unknown };
export type RpcResponse =
  | { jsonrpc: "2.0"; id: RpcId | null; result: unknown }
  | { jsonrpc: "2.0"; id: RpcId | null; error: { code: number; message: string; data?: { code: ErrorCode } } };

/** JSON-RPC's reserved codes, and the one server-defined code that carries the workspace API's
 *  error code in `data.code`. */
export const RPC = { parse: -32700, invalid: -32600, method: -32601, hcp: -32000 } as const;

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
  if (rest.length > HCP_MAX_LINE) throw new ApiError("BAD_REQUEST", "line too long");
  return { lines, rest };
}
