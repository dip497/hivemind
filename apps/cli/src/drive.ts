/**
 * The drive socket from the command line (spec/workspace-api.md "Drive socket"), through the API
 * SDK's client: the workspace API of the running app or `hive host`, as whoever the token is — the
 * agent whose tile this runs in (`HCP_TOKEN`), or the person at this machine. Its errors become the
 * CLI's, with their exit codes.
 */
import { ApiError, connect, type Identity } from "hivemind-api";
import { HcpCliError, exitCodeFor } from "./hcp.js";

export interface Drive {
  as: Identity;
  /** Call `method`; `timeoutMs` bounds this call alone. */
  call(method: string, params: unknown[], timeoutMs?: number): Promise<unknown>;
  /** Tell the host `method`, which it does not answer. */
  notice(method: string, params: unknown[]): void;
  /** Hear `event`, until the returned function is called. */
  on(event: string, listener: (...params: unknown[]) => void): () => void;
  /** Resolves when the host closes the connection. */
  closed: Promise<void>;
  close(): void;
}

const asCliError = (e: unknown): unknown => (e instanceof ApiError ? new HcpCliError(e.code, e.message, exitCodeFor(e.code)) : e);

/** Say hello on the drive socket: the connection, once the host says who this is. */
export async function openDrive(): Promise<Drive> {
  const client = await connect().catch((e: unknown) => { throw asCliError(e); });
  return {
    as: client.as,
    call: (method, params, timeoutMs) => client.call(method, params, { timeoutMs }).catch((e: unknown) => { throw asCliError(e); }),
    notice: (method, params) => client.notice(method, params),
    on: (event, listener) => client.on(event, listener),
    closed: client.closed,
    close: () => client.close(),
  };
}

/** One call on its own connection. */
export async function driveCall(method: string, params: unknown[], timeoutMs = 10_000): Promise<unknown> {
  const drive = await openDrive();
  try {
    return await drive.call(method, params, timeoutMs);
  } finally {
    drive.close();
  }
}
