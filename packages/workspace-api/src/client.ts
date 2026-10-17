/**
 * A client of a workspace's host, over any transport: a call's result comes back, and an error
 * comes back thrown, with its code; a notice goes out and nothing comes back; each event the host
 * sends reaches the listeners for it.
 */
import { ApiError, type Answer, type EventMessage } from "./protocol.js";
import type { Event, EventParams, Method, Notice, NoticeParams, Params, Result } from "./methods.js";

/** How a client reaches a host. */
export interface ClientTransport {
  /** One call out, its answer back. */
  call(method: string, params: unknown[]): Promise<Answer>;
  /** One notice out. */
  notice(method: string, params: unknown[]): void;
  /** Hand each event the host sends to `listener`. */
  events(listener: (message: EventMessage) => void): void;
}

export class WorkspaceClient {
  private readonly listeners = new Map<string, Set<(...params: unknown[]) => void>>();

  constructor(private readonly transport: ClientTransport) {
    transport.events((message) => {
      for (const listener of this.listeners.get(message.event) ?? []) {
        // One listener's failure stops none of the others; it still reaches the console.
        try { listener(...message.params); } catch (e) { console.error(`[workspace] a listener for ${message.event} failed:`, e); }
      }
    });
  }

  async call<M extends Method>(method: M, ...params: Params<M>): Promise<Result<M>> {
    const answer = await this.transport.call(method, params);
    if ("error" in answer) throw new ApiError(answer.error.code, answer.error.message);
    return answer.result as Result<M>;
  }

  notice<N extends Notice>(notice: N, ...params: NoticeParams<N>): void {
    this.transport.notice(notice, params);
  }

  /** Listen for `event`; the function returned stops. */
  on<E extends Event>(event: E, listener: (...params: EventParams<E>) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    const l = listener as (...params: unknown[]) => void;
    set.add(l);
    return () => { set!.delete(l); };
  }
}
