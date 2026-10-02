/**
 * A workspace's host, over any transport. A client holds a connection open to it: the host
 * answers the client's calls, takes its notices, and sends it events. A method with an effect on
 * the workspace or the machine is carried out through the host's intents, which record it.
 */
import type { Actor, Intent, Intents } from "@hivemind/workspace-host/intents";
import { ApiError, type Answer, type ErrorCode, type EventMessage } from "./protocol.js";
import type { Event, EventParams, Method, Notice, Result } from "./methods.js";

/** A client's connection to the host, as its transport holds it. */
export interface Connection {
  /** Who is at the other end. */
  readonly actor: Actor;
  /** Send the client an event. Never throws: a client that went is sent nothing. */
  send(event: EventMessage): void;
  /** Aborts when the client goes. */
  readonly closed: AbortSignal;
  /** Whether the client may call `method`, as its transport checks each of its calls: a peer's
   *  role, and what its device may ask. None: anything (the host's own windows). */
  may?(method: string): boolean;
}

/** Send one client `event`. */
export function emit<E extends Event>(to: Connection, event: E, ...params: EventParams<E>): void {
  to.send({ event, params });
}

/** What a method with an effect acts on, named from its params. */
export type Asks = Omit<Intent<any>, "verb">;

/** One domain on a host (git, files, …): how it answers each of its methods and takes each of its
 *  notices, and what each method with an effect acts on. A method or notice is given the
 *  connection it came over, then the call's params as they were sent: it checks them before it
 *  uses them (with `text`, `texts`, … from the protocol). An effect names what it acts on before
 *  they are checked, so only from text (`named`, `howMany`). */
export interface Domain<M extends Method, N extends Notice = never> {
  answers: { [K in M]: (from: Connection, ...params: unknown[]) => Result<K> | Promise<Result<K>> };
  effects: { [K in M]?: (...params: unknown[]) => Asks };
  notices?: { [K in N]: (from: Connection, ...params: unknown[]) => void };
  /** A connection went: let go of what it held. */
  gone?(connection: Connection): void;
}

type Handler = (from: Connection, ...params: unknown[]) => unknown;
type AnyDomain = {
  answers: Record<string, Handler>;
  effects: Record<string, ((...params: unknown[]) => Asks) | undefined>;
  notices?: Record<string, Handler>;
  gone?(connection: Connection): void;
};

/** A param as an effect's name: text, or nothing. */
export const named = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

/** How many of a list param there are, as an effect's detail: `3 files`. */
export const howMany = (values: unknown, one: string): string | undefined =>
  Array.isArray(values) ? `${values.length} ${one}${values.length === 1 ? "" : "s"}` : undefined;

export class WorkspaceServer {
  private readonly domains: AnyDomain[];
  private readonly connections = new Set<Connection>();

  /** `onError`: a notice failed, which no client is told of. */
  constructor(domains: Array<Pick<AnyDomain, "gone"> & { answers: object; effects: object; notices?: object }>, private readonly intents: Pick<Intents, "perform">, private readonly onError: (message: string) => void = () => {}) {
    this.domains = domains as unknown as AnyDomain[];
  }

  /** A client holds `connection` open: it is sent every event from now until it goes, when each
   *  domain lets go of what it held. */
  connect(connection: Connection): void {
    if (this.connections.has(connection) || connection.closed.aborted) return;
    this.connections.add(connection);
    connection.closed.addEventListener("abort", () => {
      this.connections.delete(connection);
      for (const domain of this.domains) domain.gone?.(connection);
    }, { once: true });
  }

  /** Send every connected client `event`. */
  publish<E extends Event>(event: E, ...params: EventParams<E>): void {
    this.publishTo(() => true, event, ...params);
  }

  /** Send `event` to each connected client `to` picks. */
  publishTo<E extends Event>(to: (connection: Connection) => boolean, event: E, ...params: EventParams<E>): void {
    const message: EventMessage = { event, params };
    for (const connection of this.connections) if (to(connection)) connection.send(message);
  }

  /** Send every connected client `message`, an event another host sent (M1: a workspace shared
   *  from elsewhere). */
  relay(message: EventMessage): void {
    for (const connection of this.connections) connection.send(message);
  }

  /** Answer a call of `method` with `params` that came over `from`. Never throws. */
  async answer(method: unknown, params: unknown, from: Connection): Promise<Answer> {
    const domain = typeof method === "string" ? this.domains.find((d) => Object.hasOwn(d.answers, method)) : undefined;
    if (!domain) return failed("UNKNOWN_METHOD", `unknown method: ${String(method)}`);
    if (!Array.isArray(params)) return failed("BAD_REQUEST", "params must be a list");
    const verb = method as string;
    const run = () => domain.answers[verb]!(from, ...params);
    const asks = domain.effects[verb];
    try {
      const result = asks ? await this.intents.perform(from.actor, { verb, ...asks(...params) }, run) : await run();
      return { result: result ?? null };
    } catch (e) {
      if (e instanceof ApiError) return failed(e.code, e.message);
      const err = e as { message?: unknown; code?: unknown } | null;
      const message = typeof err?.message === "string" ? err.message : String(e);
      return failed("FAILED", typeof err?.code === "string" && err.code ? `${message} (${err.code})` : message);
    }
  }

  /** Take a notice of `method` with `params` that came over `from`. Never answers and never
   *  throws: one that is unknown or fails is reported to `onError`. */
  notice(method: unknown, params: unknown, from: Connection): void {
    const domain = typeof method === "string" ? this.domains.find((d) => d.notices && Object.hasOwn(d.notices, method)) : undefined;
    if (!domain) return this.onError(`unknown notice: ${String(method)}`);
    if (!Array.isArray(params)) return this.onError(`${String(method)}: params must be a list`);
    try {
      const done = domain.notices![method as string]!(from, ...params);
      if (done instanceof Promise) done.catch((e: unknown) => this.onError(`${String(method)}: ${messageOf(e)}`));
    } catch (e) {
      this.onError(`${String(method)}: ${messageOf(e)}`);
    }
  }
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function failed(code: ErrorCode, message: string): Answer {
  return { error: { code, message } };
}
