/**
 * What each session's window title says it is doing, as its agent's manifest reads it.
 *
 * The raw title is kept whatever the host knows about the agent: a title read while the
 * agent's manifest was missing or refused would otherwise be dropped for good, because an
 * agent only sets its title again when what it is doing changes — an idle one never does.
 * The manifest can arrive later (an install, a repair, a rescan); `recompute` then answers
 * with the titles that changed, so every surface catches up without anything restarting.
 */
import { agentTitle, type AgentProviderDef } from "@hivemind/agents";

export interface TitleBook {
  /** A session's title as the agent set it. Returns the display title when it changed. */
  set(id: string, raw: string): { changed: boolean; title: string };
  /** Recompute every session's title — after the agent catalog changed. */
  recompute(): Array<{ id: string; title: string }>;
  /** What to send a viewer that has just connected. */
  current(): Array<{ id: string; title: string }>;
  forget(id: string): void;
}

/** `def` is looked up per session at report time, so a catalog that changes is picked up. */
export function titleBook(def: (id: string) => AgentProviderDef | undefined): TitleBook {
  const raw = new Map<string, string>();
  const shown = new Map<string, string>();
  // No manifest: nothing says which of this agent's titles are a task and which are its own
  // name, so the tile keeps the name it has rather than showing a guess.
  const display = (id: string): string => {
    const d = def(id);
    return d ? agentTitle(d, raw.get(id) ?? "") : "";
  };
  const apply = (id: string): { changed: boolean; title: string } => {
    const title = display(id);
    if ((shown.get(id) ?? "") === title) return { changed: false, title };
    if (title) shown.set(id, title); else shown.delete(id);
    return { changed: true, title };
  };
  return {
    set(id, rawTitle) {
      if (rawTitle) raw.set(id, rawTitle); else raw.delete(id);
      return apply(id);
    },
    recompute() {
      const out: Array<{ id: string; title: string }> = [];
      for (const id of raw.keys()) {
        const r = apply(id);
        if (r.changed) out.push({ id, title: r.title });
      }
      return out;
    },
    current() {
      return [...shown].map(([id, title]) => ({ id, title }));
    },
    forget(id) { raw.delete(id); shown.delete(id); },
  };
}
