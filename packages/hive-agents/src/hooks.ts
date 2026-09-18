/**
 * Wiring our hooks into an agent's own configuration.
 *
 * Every agent that reports deterministically runs the same scripts — the tracker, the turn
 * hooks, the permission broker — and differs only in the document it wants them written
 * into: claude takes a JSON blob as an argument, droid reads a file with the events at the
 * top level, another might want something else again. A manifest names the events and the
 * hooks; the daemon renders the commands, quotes them, and decides what is available.
 *
 * The rules a manifest may rely on are closed, and all four exist because a real agent
 * needs them: an entry whose script the daemon does not have is dropped, an entry marked
 * `when: supervised` appears only for a supervised tile, `matcher: supervise` becomes the
 * tools that tile's policy covers, and the whole document is omitted when nothing is left.
 */
import { shq } from "./shq.js";
import type { AgentHookEntry, AgentHooks, AgentProviderDef } from "./types.js";
import type { HookScript, LaunchRequest } from "./runtime.js";

/** Hooks that need more than the tile's name in front of the command. */
const ENV_PREFIX: Record<string, (req: LaunchRequest) => Record<string, string>> = {
  // The broker double-checks the policy itself and falls back to the normal prompt.
  approval: (req): Record<string, string> => (req.supervise ? { HIVE_SUPERVISE: req.supervise } : {}),
};

/** The command line the daemon runs for one of its own hooks, attributed to a tile. */
export function hookCommand(name: string, hook: HookScript, req: LaunchRequest): string {
  // A document written once for every tile of an agent cannot name one of them; those hooks
  // are attributed by the spawn environment instead, which carries the same tile id.
  const env = { ...(req.tileId ? { HIVEMIND_TILE: req.tileId } : {}), ...(ENV_PREFIX[name]?.(req) ?? {}) };
  const parts = Object.entries(env).map(([k, v]) => `${k}=${shq(v)}`);
  parts.push("ELECTRON_RUN_AS_NODE=1", shq(req.paths.execPath), shq(hook.path));
  if (hook.arg) parts.push(shq(hook.arg));
  return parts.join(" ");
}

/** "all" covers every tool; anything else is the list the supervisor named. */
function matcherFor(entry: AgentHookEntry, req: LaunchRequest): string | undefined {
  if (entry.matcher !== "supervise") return entry.matcher;
  const policy = req.supervise ?? "";
  return policy === "all" ? "*" : policy.split(",").map((s) => s.trim()).filter(Boolean).join("|");
}

/** The default shapes — the ones claude introduced and most agents copied. */
const DEFAULT_ENTRY: Record<string, unknown> = { type: "command", command: "{command}", timeout: "{timeout}" };
const DEFAULT_GROUP: Record<string, unknown> = { matcher: "{matcher}", hooks: "{entries}" };

/** Fill a shape: a placeholder with no value takes its key out of the object entirely, so
 *  an agent that wants no timeout simply never gets the key. */
function fill(shape: Record<string, unknown>, values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, template] of Object.entries(shape)) {
    if (typeof template !== "string") { out[key] = template; continue; }
    const match = /^\{(\w+)\}$/.exec(template);
    if (!match) { out[key] = template; continue; }
    const value = values[match[1]!];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** One rendered command, plus the matcher it belongs to — which an agent carries either on
 *  the command itself or on the group around it, so both stages are given it. */
function entryFor(
  entry: AgentHookEntry,
  hooks: AgentHooks,
  req: LaunchRequest,
): { body: Record<string, unknown>; matcher?: string } | undefined {
  if (entry.when === "supervised" && !req.supervise) return undefined;
  const hook = req.paths.hooks[entry.hook];
  if (!hook) return undefined; // the daemon does not have this script: the event is not wired
  const matcher = matcherFor(entry, req);
  const values = { command: hookCommand(entry.hook, hook, req), timeout: entry.timeout, matcher };
  return { body: fill(hooks.entry ?? DEFAULT_ENTRY, values), ...(matcher ? { matcher } : {}) };
}

/** The events object an agent's configuration carries, or undefined when none apply. */
export function renderHookEvents(hooks: AgentHooks, req: LaunchRequest): Record<string, unknown[]> | undefined {
  const out: Record<string, unknown[]> = {};
  for (const [event, spec] of Object.entries(hooks.events)) {
    const declared = Array.isArray(spec) ? spec : [spec];
    const entries = declared.map((e) => entryFor(e, hooks, req)).filter(Boolean) as Array<{ body: Record<string, unknown>; matcher?: string }>;
    if (!entries.length) continue;
    // Some agents want a plain list of commands; others wrap each one in a group that can
    // carry a matcher. The manifest says which — it is a property of that CLI, not of us.
    if (hooks.group === false) { out[event] = entries.map((e) => e.body); continue; }
    const shape = hooks.group ?? DEFAULT_GROUP;
    out[event] = entries.map((e) => fill(shape, { matcher: e.matcher, entries: [e.body] }));
  }
  return Object.keys(out).length ? out : undefined;
}

/** The whole document, in the shape the agent's own configuration wants. */
export function renderHookDocument(def: AgentProviderDef, req: LaunchRequest): string | undefined {
  if (!def.hooks) return undefined;
  const events = renderHookEvents(def.hooks, req);
  if (!events) return undefined;
  const template = def.hooks.template ?? "{events}";
  return template.replace("{events}", JSON.stringify(events));
}
