/**
 * The plugins running in one window, each with one lifecycle (`docs/design/plugin-control-2026-10-16.md`),
 * and what an agent does with them (`hive ctl plugin list|open|call|close`): every verb reads the
 * state this keeps, so a plugin that is still starting is waited for, one that failed says why,
 * and each refusal carries the code the agent's exit status is made from.
 *
 *   starting ──connected──► ready
 *      │ did not start in START_MS,  │ disabled
 *      │ disabled                    ▼
 *      └──────────────────────────► failed
 *   any ──stopped──► gone
 *
 * The window's link host feeds it (`started`, then `connected`, `disabled`, `stop`); nothing else
 * changes a plugin's state.
 */
import type { PluginCommand } from "@hivemind/view-sdk/commands";
import { INVOKE_ARGS_MAX } from "@hivemind/view-sdk/protocol";
import type { ErrorCode } from "@hivemind/workspace-api/protocol";
import type { PluginInstance, PluginState } from "@hivemind/workspace-api/plugins";

/** What happens to a running plugin. */
export type PluginEvent = { type: "connected" } | { type: "disabled"; reason: string } | { type: "timedOut" };

const NEXT: Record<PluginState, Partial<Record<PluginEvent["type"], PluginState>>> = {
  starting: { connected: "ready", disabled: "failed", timedOut: "failed" },
  ready: { disabled: "failed" },
  failed: {},
};

/** The state `event` takes a plugin in `state` to; null when it changes nothing. */
export function transition(state: PluginState, event: PluginEvent): PluginState | null {
  return NEXT[state][event.type] ?? null;
}

/** How long a plugin's code has to connect before it counts as failed. */
export const START_MS = 15_000;

/** A refusal, with the code an agent branches on. */
export class PluginError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
    this.name = "PluginError";
  }
}

/** A plugin as its host starts it. */
export interface Starting {
  plugin: string;
  kind: PluginInstance["kind"];
  instance: string;
  label: string;
  /** What its manifest lets an agent run. */
  commands: readonly PluginCommand[];
  /** Run one of them; reject with why it failed. */
  call(name: string, args: unknown, timeoutMs: number): Promise<unknown>;
}

/** The handle its host tells what happens to it. */
export interface Running {
  connected(): void;
  disabled(reason: string): void;
  /** Its name or declared commands changed. */
  update(change: { label?: string; commands?: readonly PluginCommand[] }): void;
  stop(): void;
}

interface Entry extends Starting {
  state: PluginState;
  reason?: string;
  since: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Which running plugin: by its copy, else by plugin when it runs once. */
export interface Match { plugin?: string; instance?: string }

export class PluginInstances {
  /** In the order they started; a remount is a new entry, so a late unmount removes only its own. */
  private readonly entries = new Set<Entry>();
  private readonly waiters = new Set<() => void>();

  /** A plugin's host mounted it: it is `starting` until its code connects. */
  start(s: Starting): Running {
    const e: Entry = { ...s, commands: [...s.commands], state: "starting", since: Date.now(), timer: null };
    e.timer = setTimeout(() => this.fire(e, { type: "timedOut" }), START_MS);
    this.entries.add(e);
    this.changed();
    return {
      connected: () => this.fire(e, { type: "connected" }),
      disabled: (reason) => this.fire(e, { type: "disabled", reason }),
      update: (c) => {
        if (!this.entries.has(e)) return;
        if (c.label !== undefined) e.label = c.label;
        if (c.commands) e.commands = [...c.commands];
        this.changed();
      },
      stop: () => {
        if (!this.entries.delete(e)) return;
        if (e.timer) clearTimeout(e.timer);
        this.changed();
      },
    };
  }

  /** Every running plugin, in the order they started. */
  list(): PluginInstance[] {
    return [...this.newestByInstance()].map(snapshot);
  }

  /** The running plugin `match` names, if one does. */
  find(match: Match): PluginInstance | undefined {
    const e = this.pick(match);
    return e && snapshot(e);
  }

  /** The plugin `match` names, once it is past starting; at `deadline`, as it is then (null: none
   *  runs). What `plugin open` answers: a plugin the agent can call at once, or why not. */
  async settle(match: Match, deadline: number): Promise<PluginInstance | null> {
    const e = await this.until(() => {
      const found = this.pick(match);
      return found && found.state !== "starting" ? found : undefined;
    }, deadline);
    const now = e ?? this.pick(match);
    return now ? snapshot(now) : null;
  }

  /** Whether the plugin `match` names has stopped by `deadline`: what `plugin close` waits for. */
  async gone(match: Match, deadline: number): Promise<boolean> {
    return (await this.until(() => (this.pick(match) ? undefined : true), deadline)) ?? false;
  }

  /** Run `command` of the running `plugin` (its copy `instance`, when it runs more than once), by `deadline`. */
  async call(plugin: string, command: string, args: unknown, instance: string | undefined, deadline: number): Promise<unknown> {
    let size = Infinity;
    try { size = JSON.stringify(args ?? null).length; } catch { /* not JSON */ }
    if (size > INVOKE_ARGS_MAX) throw new PluginError("BAD_REQUEST", `its argument must be JSON of at most ${INVOKE_ARGS_MAX} bytes`);
    const running = [...this.newestByInstance()].filter((e) => e.plugin === plugin);
    if (!running.length) throw new PluginError("NOT_FOUND", `${plugin} is not running here: open it with \`hive ctl plugin open\` (\`hive ctl plugin list\` shows what runs)`);
    const chosen = instance ? running.filter((e) => e.instance === instance) : running;
    if (!chosen.length) throw new PluginError("NOT_FOUND", `${plugin} has no copy ${instance}; running: ${running.map((e) => e.instance).join(", ")}`);
    if (chosen.length > 1) throw new PluginError("BAD_REQUEST", `${plugin} runs ${chosen.length} times; say which with --tile: ${chosen.map((e) => `${e.instance} (${e.label})`).join(", ")}`);
    const e = chosen[0]!;
    if (e.state === "starting") {
      await this.until(() => (e.state !== "starting" || !this.entries.has(e) ? e : undefined), deadline);
      if (!this.entries.has(e)) throw new PluginError("NOT_FOUND", `${plugin} stopped before it was ready`);
      if (e.state === "starting") throw new PluginError("TIMEOUT", `${plugin} is still starting`);
    }
    if (e.state === "failed") throw new PluginError("FAILED", `${plugin} stopped: ${e.reason ?? "it failed"}`);
    if (!e.commands.some((c) => c.name === command)) {
      throw new PluginError("NOT_FOUND", `${plugin} has no command "${command}"; it has ${e.commands.map((c) => c.name).join(", ") || "none"}`);
    }
    const left = deadline - Date.now();
    if (left <= 0) throw new PluginError("TIMEOUT", `no time was left to run "${command}"`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PluginError("TIMEOUT", `${plugin} did not answer "${command}" in ${Math.round(left / 1000)} s`)), left);
    });
    try {
      // The link's own wait is longer: the reason the agent reads is this one, or the plugin's.
      return await Promise.race([e.call(command, args ?? null, left + 1_000), late]);
    } catch (err) {
      if (err instanceof PluginError) throw err;
      const why = (err as Error)?.message ?? String(err);
      throw new PluginError("FAILED", this.entries.has(e) && e.state === "ready" ? why : `${plugin} stopped while it ran "${command}": ${why}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private fire(e: Entry, event: PluginEvent): void {
    if (!this.entries.has(e)) return;
    const to = transition(e.state, event);
    if (!to) return;
    e.state = to;
    e.since = Date.now();
    if (event.type === "disabled") e.reason = event.reason;
    else if (event.type === "timedOut") e.reason = `it did not start in ${START_MS / 1000} s`;
    if (e.timer) { clearTimeout(e.timer); e.timer = null; }
    this.changed();
  }

  private changed(): void {
    for (const w of [...this.waiters]) w();
  }

  /** The newest entry of each copy: a remount stands in for the mount it replaces. */
  private newestByInstance(): Set<Entry> {
    const newest = new Map<string, Entry>();
    for (const e of this.entries) {
      const key = `${e.kind}\0${e.instance}`;
      newest.delete(key);
      newest.set(key, e);
    }
    return new Set(newest.values());
  }

  private pick(match: Match): Entry | undefined {
    let found: Entry | undefined;
    for (const e of this.newestByInstance()) {
      if ((match.instance === undefined || e.instance === match.instance) && (match.plugin === undefined || e.plugin === match.plugin)) found = e;
    }
    return found;
  }

  /** `pick`'s answer once it has one, else undefined at `deadline`. */
  private until<T>(pick: () => T | undefined, deadline: number): Promise<T | undefined> {
    const first = pick();
    if (first !== undefined) return Promise.resolve(first);
    return new Promise((resolve) => {
      const done = (v: T | undefined) => { this.waiters.delete(check); clearTimeout(timer); resolve(v); };
      const check = () => { const v = pick(); if (v !== undefined) done(v); };
      const timer = setTimeout(() => done(pick()), Math.max(0, deadline - Date.now()));
      this.waiters.add(check);
    });
  }
}

function snapshot(e: Entry): PluginInstance {
  return {
    plugin: e.plugin, kind: e.kind, instance: e.instance, label: e.label, state: e.state,
    ...(e.reason !== undefined ? { reason: e.reason } : {}), since: e.since,
    commands: e.commands.map((c) => ({ name: c.name, description: c.description, ...(c.args ? { args: c.args } : {}) })),
  };
}
