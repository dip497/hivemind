/**
 * A workspace's host, over any transport. It answers a method from the domain that has it; a
 * method with an effect on the workspace or the machine is carried out through the host's
 * intents, which record it.
 */
import type { Actor, Intent, Intents } from "@hivemind/workspace-host/intents";
import { ApiError, type Answer, type ErrorCode } from "./protocol.js";
import type { Method, Result } from "./methods.js";

/** What a method with an effect acts on, named from its params. */
export type Asks = Omit<Intent<any>, "verb">;

/** One domain on a host (git, files, …): how it answers each of its methods, and what each of
 *  them with an effect acts on. Both take a call's params as they were sent: an answer checks
 *  them before it uses them (with `text`, `texts`, … from the protocol), and an effect names what
 *  it acts on before they are checked, so only from text (`named`, `howMany`). */
export interface Domain<M extends Method> {
  answers: { [K in M]: (...params: unknown[]) => Result<K> | Promise<Result<K>> };
  effects: { [K in M]?: (...params: unknown[]) => Asks };
}

type AnyDomain = { answers: Record<string, (...params: unknown[]) => unknown>; effects: Record<string, ((...params: unknown[]) => Asks) | undefined> };

/** A param as an effect's name: text, or nothing. */
export const named = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

/** How many of a list param there are, as an effect's detail: `3 files`. */
export const howMany = (values: unknown, one: string): string | undefined =>
  Array.isArray(values) ? `${values.length} ${one}${values.length === 1 ? "" : "s"}` : undefined;

export class WorkspaceServer {
  private readonly domains: AnyDomain[];

  constructor(domains: Domain<any>[], private readonly intents: Pick<Intents, "perform">) {
    this.domains = domains as unknown as AnyDomain[];
  }

  /** Answer `actor`'s call of `method` with `params`. Never throws. */
  async answer(method: unknown, params: unknown, actor: Actor): Promise<Answer> {
    const domain = typeof method === "string" ? this.domains.find((d) => Object.hasOwn(d.answers, method)) : undefined;
    if (!domain) return failed("UNKNOWN_METHOD", `unknown method: ${String(method)}`);
    if (!Array.isArray(params)) return failed("BAD_REQUEST", "params must be a list");
    const verb = method as string;
    const run = () => domain.answers[verb]!(...params);
    const asks = domain.effects[verb];
    try {
      const result = asks ? await this.intents.perform(actor, { verb, ...asks(...params) }, run) : await run();
      return { result: result ?? null };
    } catch (e) {
      if (e instanceof ApiError) return failed(e.code, e.message);
      const err = e as { message?: unknown; code?: unknown } | null;
      const message = typeof err?.message === "string" ? err.message : String(e);
      return failed("FAILED", typeof err?.code === "string" && err.code ? `${message} (${err.code})` : message);
    }
  }
}

function failed(code: ErrorCode, message: string): Answer {
  return { error: { code, message } };
}
