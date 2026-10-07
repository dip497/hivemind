/**
 * The workspace as an in-app plugin reads and acts on it: one feed and one set of verbs, whatever
 * shows them. A widget's code reads it now; anything else in the app that wants the workspace's
 * agents (a notifier, a view, a panel) reads the same. The agents come from the host's agent feed,
 * the one a phone and the CLI follow too (`agent.list`, then `agent.changed` and `agent.event`);
 * the actions go through the workspace's own commands.
 *
 * Every verb that changes something needs the permission its plugin's manifest asked for, named as
 * a view's are; an instruction to an agent is shown to the person, who sends or cancels it, each
 * time. A plugin with no permissions may read and point at things, nothing more.
 */
import type { ViewPermission } from "@hivemind/view-sdk/protocol";
import type { AgentEvent, AgentItem } from "@hivemind/workspace-api/agents";

export type { AgentEvent, AgentItem };

/** What a plugin may ask the workspace to do, and the permission each needs (null: none). */
export const KIT_VERBS = {
  focus: null,
  spawn: "workspace:spawn",
  prompt: "workspace:prompt",
  close: "workspace:close",
} as const satisfies Record<string, ViewPermission | null>;
export type KitVerb = keyof typeof KIT_VERBS;

/** Who asks: a plugin, by name, with the permissions its manifest was granted. */
export interface KitCaller { name: string; permissions: readonly string[] }

/** What the window lends the kit: its commands, and what it calls things. */
export interface KitHost {
  focus(tile: string): void;
  spawn(agent: string | null, frame: string | null, opts: { prompt?: string }): boolean;
  close(tile: string): void;
  tileName(tile: string): string | undefined;
}

let host: KitHost | null = null;
/** The window that shows a workspace lends it its commands; null when it goes. */
export function provideKitHost(h: KitHost | null): void { host = h; }

// ── reading ──────────────────────────────────────────────────────────────────

/** Follow the agents in `repo`: listed once, then kept by the feed's changes, each told once.
 *  Changes heard before the list answers are kept and applied after it, as far as they are newer. */
export function watchAgents(repo: string, cb: (agents: AgentItem[]) => void): () => void {
  let live = true;
  let seq: number | null = null;
  const agents = new Map<string, AgentItem>();
  const early: Array<Parameters<Parameters<typeof window.hive.onAgentChanged>[0]>[1]> = [];
  const apply = (c: (typeof early)[number]): void => {
    if (seq !== null && c.seq <= seq) return;
    if ("agent" in c) agents.set(c.agent.tile, c.agent); else agents.delete(c.gone);
  };
  const stop = window.hive.onAgentChanged((r, change) => {
    if (r !== repo) return;
    if (seq === null) { early.push(change); return; }
    apply(change);
    seq = Math.max(seq, change.seq);
    cb([...agents.values()]);
  });
  void window.hive.agentList(repo).then((listed) => {
    if (!live) return;
    for (const a of listed.agents) agents.set(a.tile, a);
    seq = listed.seq;
    for (const c of early) apply(c);
    early.length = 0;
    cb([...agents.values()]);
  }).catch(() => { if (live) cb([]); });
  return () => { live = false; stop(); };
}

/** Hear what happens to the agents in `repo`: a turn ended, one waits on the person or was
 *  answered, one came or went. */
export function watchEvents(repo: string, cb: (e: AgentEvent) => void): () => void {
  return window.hive.onAgentEvent((r, e) => { if (r === repo) cb(e); });
}

// ── acting ───────────────────────────────────────────────────────────────────

/** Do `verb` for `caller` in `repo`, if its manifest asked for what the verb needs. Throws why not. */
export async function act(caller: KitCaller, verb: string, args: unknown[]): Promise<unknown> {
  if (!Object.hasOwn(KIT_VERBS, verb)) throw new Error(`no such action: ${verb}`);
  const need = KIT_VERBS[verb as KitVerb];
  if (need && !caller.permissions.includes(need)) throw new Error(`${caller.name} did not ask for ${need}`);
  if (!host) throw new Error("no workspace is shown");
  const text = (v: unknown, what: string, max = 4000): string => {
    if (typeof v !== "string" || !v.trim()) throw new Error(`${what} is required`);
    return v.slice(0, max);
  };
  switch (verb as KitVerb) {
    case "focus": host.focus(text(args[0], "tile", 200)); return null;
    case "close": host.close(text(args[0], "tile", 200)); return null;
    case "spawn": {
      const o = (args[1] ?? {}) as { prompt?: unknown; frame?: unknown };
      const prompt = typeof o.prompt === "string" ? o.prompt.slice(0, 4000) : undefined;
      if (prompt && !(await confirmAsk({ from: caller.name, where: "A new agent", text: prompt }))) return { started: false };
      return { started: host.spawn(typeof args[0] === "string" ? args[0] : null, typeof o.frame === "string" ? o.frame : null, prompt ? { prompt } : {}) };
    }
    case "prompt": {
      const tile = text(args[0], "tile", 200);
      const said = text(args[1], "text");
      if (!(await confirmAsk({ from: caller.name, where: `To “${host.tileName(tile) ?? tile}”`, text: said }))) return { sent: false };
      await window.hive.viewPrompt(tile, said);
      return { sent: true };
    }
  }
}

// ── the person confirms what a plugin wrote ──────────────────────────────────

interface Ask { from: string; where: string; text: string; answer: (send: boolean) => void }
let asking: Ask | null = null;
const askListeners = new Set<() => void>();
const asked = () => { for (const l of askListeners) l(); };

/** The ask waiting for the person now, and how to hear when it changes (workspace-kit-confirm.tsx). */
export const kitAsk = { now: (): Ask | null => asking, subscribe: (l: () => void) => { askListeners.add(l); return () => { askListeners.delete(l); }; } };

function confirmAsk(ask: Omit<Ask, "answer">): Promise<boolean> {
  // One at a time: a plugin asking again while one waits is told no.
  if (asking) return Promise.resolve(false);
  return new Promise((resolve) => {
    asking = { ...ask, answer: (send) => { asking = null; asked(); resolve(send); } };
    asked();
  });
}
