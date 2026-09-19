/** The app's agent list, for commands that need it. Lazy: the YAML loader import costs ~65 ms. */
import { defaultAgent } from "@hivemind/agents";

let loading: Promise<void> | null = null;
let preferred: string | null = null;

/** The agent `hive ctl spawn` starts with no --agent: the user's default if installed,
 *  else the first agent on this PATH. Null when no agent is installed at all.
 *  Valid after `ensureAgentCatalog()`. */
export function cliDefaultAgent(): string | null {
  return preferred ?? defaultAgent()?.id ?? null;
}

export function ensureAgentCatalog(): Promise<void> {
  loading ??= (async () => {
    try {
      const [{ loadAgents }, { setCatalog, preferredAgent }, core, { findBin }] = await Promise.all([
        import("@hivemind/agents/load"),
        import("@hivemind/agents"),
        import("@hivemind/core"),
        import("@hivemind/agents/discover"),
      ]);
      const repoRoot = await core.findRoot().catch(() => null);
      const settings = await core.readSettings().catch(() => null);
      const disabled = settings?.agents.disabled ?? [];
      const { defs } = await loadAgents({
        repoRoot: repoRoot ?? undefined,
        disabled,
      });
      setCatalog(defs);
      preferred = preferredAgent(settings?.agents.defaultAgent, (d) => !!findBin(d.bin))?.id ?? null;
    } catch { /* nothing installed is a fine answer */ }
  })();
  return loading;
}
