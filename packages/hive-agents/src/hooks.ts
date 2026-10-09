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
import { createHash } from "node:crypto";
import { shq } from "./shq.js";
import type { AgentHookEntry, AgentHooks, AgentProviderDef } from "./types.js";
import type { HookScript, LaunchRequest } from "./runtime.js";
import { EVENT_ENV, EVENT_HOOK } from "./events.js";

/** What the generic script reports for an `emit` entry. */
function emitEnv(entry: AgentHookEntry | undefined): Record<string, string> {
  if (!entry?.emit) return {};
  return {
    [EVENT_ENV.event]: entry.emit,
    ...(entry.outcome ? { [EVENT_ENV.outcome]: entry.outcome } : {}),
    ...(entry.kind ? { [EVENT_ENV.kind]: entry.kind } : {}),
  };
}

/** The variables a hook runs with, attributed to a tile. */
function hookEnv(hook: HookScript, req: LaunchRequest, entry?: AgentHookEntry): Record<string, string> {
  // A document written once for every tile of an agent cannot name one of them; those hooks
  // are attributed by the spawn environment instead, which carries the same tile id.
  return {
    ...(req.tileId ? { HIVEMIND_TILE: req.tileId } : {}),
    // A plugin's approval script double-checks the policy itself.
    ...(req.supervise && hook.env ? { HIVE_SUPERVISE: req.supervise } : {}),
    ...hook.env,
    ...emitEnv(entry),
  };
}

/** Single-quote for a PowerShell literal — the only escape inside one is a doubled quote. */
function pshq(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Used when the render context names no Windows root. Forward slashes, never backslashes:
 *  a backslash would be eaten by the POSIX-style shells that can end up running this line. */
const DEFAULT_SYSTEM_ROOT = "C:/Windows";

/** The command line for one of our hooks on Windows, where no POSIX shell stands in front
 *  of it. The script travels base64-encoded (UTF-16LE) so the rendered string is only a
 *  forward-slash path plus bare base64 — no quotes, `$` or backslashes — and survives any
 *  interpreter unchanged. The hook inherits stdin, where the agent hands it its JSON payload. */
function win32HookCommand(env: Record<string, string>, hook: HookScript, req: LaunchRequest): string {
  const root = (req.env.SystemRoot ?? DEFAULT_SYSTEM_ROOT).replace(/\\/g, "/");
  const exe = `${root}/System32/WindowsPowerShell/v1.0/powershell.exe`;
  const pairs: Array<[string, string]> = [...Object.entries(env), ["ELECTRON_RUN_AS_NODE", "1"]];
  const sets = pairs.map(([k, v]) => `$env:${k}=${pshq(v)}`).join("; ");
  // The call operator returns at once for a GUI-subsystem exe (ours is one), so start it through
  // .NET: no shell and no redirection means it inherits stdin/stdout and can be waited on.
  const winArg = (v: string): string => `"${v}"`; // a Windows path cannot contain a double quote
  const args = [hook.path, ...(hook.arg ? [hook.arg] : [])].map(winArg).join(" ");
  const script = [
    "$ProgressPreference='SilentlyContinue'", ...(sets ? [sets] : []),
    "$s=New-Object System.Diagnostics.ProcessStartInfo",
    `$s.FileName=${pshq(req.paths.execPath)}`, `$s.Arguments=${pshq(args)}`, "$s.UseShellExecute=$false",
    "$p=[System.Diagnostics.Process]::Start($s)", "$p.WaitForExit()", "exit $p.ExitCode",
  ].join("; ");
  return `${exe} -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
}

/** The variable a stable hook command reads its script's path from (`_ARG`: its argument). */
const stableVar = (name: string): string => `HIVEMIND_HOOK_${name.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
const STABLE_EXEC = "HIVEMIND_HOOK_EXEC";

/** A stable hook's command names no path: the binary, the script and its argument come from the
 *  agent's environment (`stableHookEnv`), set at launch by whichever app started it. So the text is
 *  the same for every install and build, and an agent that asks before running a hook it has not
 *  seen (codex) is asked once, not each time another app or version starts it. It needs the agent
 *  to run hooks through a shell, as codex does. */
function stableHookCommand(name: string, hook: HookScript, entry?: AgentHookEntry): string {
  const env = emitEnv(entry);
  const v = stableVar(name);
  return ["env", ...Object.entries(env).map(([k, x]) => `${k}=${shq(x)}`), "ELECTRON_RUN_AS_NODE=1",
    `"$${STABLE_EXEC}"`, `"$${v}"`, ...(hook.arg ? [`"$${v}_ARG"`] : [])].join(" ");
}

/** What a stable hook command reads from the agent's environment: each script it may run, its
 *  argument, the variables it is told (an asset hook's SDK paths), and the binary that runs them. */
export function stableHookEnv(def: AgentProviderDef, req: LaunchRequest): Record<string, string> {
  if (!def.hooks?.stable || (req.platform ?? process.platform) === "win32") return {};
  const out: Record<string, string> = { [STABLE_EXEC]: req.paths.execPath };
  for (const [name, hook] of Object.entries(req.paths.hooks)) {
    out[stableVar(name)] = hook.path;
    if (hook.arg) out[`${stableVar(name)}_ARG`] = hook.arg;
    Object.assign(out, hook.env);
  }
  return out;
}

/** The command line the daemon runs for one of its own hooks, attributed to a tile. It starts
 *  with `env` so it runs the same whether the agent hands it to a shell or splits it into argv. */
export function hookCommand(hook: HookScript, req: LaunchRequest, entry?: AgentHookEntry): string {
  const env = hookEnv(hook, req, entry);
  if ((req.platform ?? process.platform) === "win32") return win32HookCommand(env, hook, req);
  const parts = ["env", ...Object.entries(env).map(([k, v]) => `${k}=${shq(v)}`)];
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
  const name = entry.emit ? EVENT_HOOK : entry.hook ?? "";
  const hook = req.paths.hooks[name];
  if (!hook) return undefined; // the daemon does not have this script: the event is not wired
  const matcher = matcherFor(entry, req);
  const stable = hooks.stable && (req.platform ?? process.platform) !== "win32";
  const values = { command: stable ? stableHookCommand(name, hook, entry) : hookCommand(hook, req, entry), timeout: entry.timeout, matcher };
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

/** A value as a TOML inline value: tables `{k=v,...}`, arrays, and strings in TOML's
 *  basic-string escapes (a subset JSON also uses, so JSON.stringify writes them). */
function toTomlInline(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(toTomlInline).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.entries(v).map(([k, x]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)}=${toTomlInline(x)}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** JSON with every object's keys sorted, as codex serializes a hook before hashing it. */
function sortedJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(sortedJson).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${sortedJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/** Events whose matcher codex ignores, and leaves out of the hash. */
const CODEX_NO_MATCHER = new Set(["user_prompt_submit", "stop", "interrupt"]);

/** What codex records once its user trusts each of these hooks, keyed as it keys hooks passed on
 *  its command line: the sha256 of the hook as it reads it (event, matcher, the handler with its
 *  defaults filled in). Given at launch, the hooks this document wires run without asking. */
function codexTrust(events: Record<string, unknown[]>): Record<string, { trusted_hash: string }> {
  const out: Record<string, { trusted_hash: string }> = {};
  for (const [event, groups] of Object.entries(events)) {
    const label = event.replace(/(?<!^)([A-Z])/g, "_$1").toLowerCase();
    groups.forEach((g, gi) => {
      const group = g as { matcher?: string; hooks?: Array<Record<string, unknown>> };
      (group.hooks ?? []).forEach((h, hi) => {
        if (h.type !== "command") return;
        const t = typeof h.timeout === "number" ? h.timeout : undefined;
        const timeout = label === "session_end" || label === "interrupt" ? Math.min(3, Math.max(1, t ?? 1)) : Math.max(1, t ?? 600);
        const handler = { type: "command", command: h.command, timeout, async: h.async === true,
          ...(typeof h.statusMessage === "string" ? { statusMessage: h.statusMessage } : {}),
          ...(typeof h.commandWindows === "string" ? { commandWindows: h.commandWindows } : {}) };
        const matcher = CODEX_NO_MATCHER.has(label) ? undefined : group.matcher;
        const identity = { event_name: label, hooks: [handler], ...(matcher !== undefined ? { matcher } : {}) };
        out[`/<session-flags>/config.toml:${label}:${gi}:${hi}`] = { trusted_hash: `sha256:${createHash("sha256").update(sortedJson(identity)).digest("hex")}` };
      });
    });
  }
  return out;
}

/** The whole document, in the shape the agent's own configuration wants. */
export function renderHookDocument(def: AgentProviderDef, req: LaunchRequest): string | undefined {
  if (!def.hooks) return undefined;
  // Commands every tile shares carry no tile id; the tile is in the spawn environment.
  const rendered = renderHookEvents(def.hooks, def.hooks.stable ? { ...req, tileId: "", supervise: undefined } : req);
  if (!rendered) return undefined;
  const events = def.hooks.trust === "codex" ? { ...rendered, state: codexTrust(rendered) } : rendered;
  const template = def.hooks.template ?? "{events}";
  return template.replace("{events}", def.hooks.format === "toml" ? toTomlInline(events) : JSON.stringify(events));
}
