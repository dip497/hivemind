/**
 * A client of a workspace's host, over any transport: a call's result comes back, and an error
 * comes back thrown, with its code.
 */
import { ApiError, type Answer } from "./protocol.js";
import type { Method, Params, Result } from "./methods.js";

/** How a client reaches a host: one call out, its answer back. */
export interface ClientTransport {
  call(method: string, params: unknown[]): Promise<Answer>;
}

export class WorkspaceClient {
  constructor(private readonly transport: ClientTransport) {}

  async call<M extends Method>(method: M, ...params: Params<M>): Promise<Result<M>> {
    const answer = await this.transport.call(method, params);
    if ("error" in answer) throw new ApiError(answer.error.code, answer.error.message);
    return answer.result as Result<M>;
  }
}
