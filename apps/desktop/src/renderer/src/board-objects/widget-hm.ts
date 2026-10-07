/**
 * A widget's `hive.hm`, window side: the worker names a call of the view client the window holds
 * for it (`CLIENT_CALLS`, or one of its commands), with callbacks as ids; the answer, each
 * callback's calls and the client's values go back by message. Nothing else of the client, nor
 * of anything it leads to, can be named: the worker's names are checked against those lists.
 */
import { CLIENT_CALLS, CLIENT_VALUES, COMMAND_PERMISSION, type ViewClient } from "@hivemind/view-sdk";

type FromWorker =
  | { type: "hm-call"; req: number; path: unknown; args: unknown }
  | { type: "hm-unsub"; req: number };

const CALLS = new Set<string>(CLIENT_CALLS);
const COMMANDS = new Set<string>(Object.keys(COMMAND_PERMISSION));

/** What of `client` the worker may call by `path`, or null. */
function callable(client: ViewClient, path: unknown): ((...a: unknown[]) => unknown) | null {
  if (!Array.isArray(path) || !path.every((p) => typeof p === "string")) return null;
  const [first, second] = path as string[];
  if (path.length === 1 && first && CALLS.has(first)) return (client[first as (typeof CLIENT_CALLS)[number]] as (...a: unknown[]) => unknown).bind(client);
  if (path.length === 2 && first === "commands" && second && COMMANDS.has(second)) {
    return client.commands[second as keyof ViewClient["commands"]] as (...a: unknown[]) => unknown;
  }
  return null;
}

/** The values the worker keeps a copy of, as they are now. */
export function clientValues(client: ViewClient): Record<string, unknown> {
  return Object.fromEntries(CLIENT_VALUES.map((k) => [k, JSON.parse(JSON.stringify(client[k] ?? null))]));
}

export interface WidgetBridge {
  handle(m: { type: string }): void;
  /** Send the client's values again (its settings changed). */
  refresh(): void;
  dispose(): void;
}

export function bridgeClient(client: ViewClient, post: (m: unknown) => void): WidgetBridge {
  const subs = new Map<number, () => void>();
  const reply = (req: number, r: { ok: true; value: unknown } | { ok: false; error: string }) => {
    try { post({ type: "hm-reply", req, ...r }); } catch { post({ type: "hm-reply", req, ok: false, error: "its answer cannot be sent to a widget" }); }
  };
  const refresh = () => post({ type: "hm-values", values: clientValues(client) });
  refresh();
  return {
    refresh,
    handle(raw) {
      const m = raw as FromWorker;
      if (m.type === "hm-unsub") { subs.get(m.req)?.(); subs.delete(m.req); return; }
      if (m.type !== "hm-call" || typeof m.req !== "number") return;
      const fn = callable(client, m.path);
      if (!fn) { reply(m.req, { ok: false, error: `hive.hm has no ${Array.isArray(m.path) ? m.path.join(".") : "such call"}` }); return; }
      const args = (Array.isArray(m.args) ? m.args : []).map((a) => {
        const id = (a as { __fn?: unknown } | null)?.__fn;
        return typeof id === "number" ? (...cb: unknown[]) => post({ type: "hm-cb", fn: id, args: cb }) : a;
      });
      let out: unknown;
      try { out = fn(...args); } catch (e) { reply(m.req, { ok: false, error: e instanceof Error ? e.message : String(e) }); return; }
      if (typeof out === "function") { subs.set(m.req, out as () => void); return; }
      Promise.resolve(out).then(
        (value) => reply(m.req, { ok: true, value: value ?? null }),
        (e: unknown) => reply(m.req, { ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    },
    dispose() { for (const off of subs.values()) off(); subs.clear(); },
  };
}
