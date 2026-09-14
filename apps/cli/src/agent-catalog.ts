/** The app's agent list, for commands that need it. Lazy: the YAML loader import costs ~65 ms. */
import { defaultAgent } from "@hivemind/agents";

let loading: Promise<void> | null = null;
let preferred: string | null = null;

/** The agent `hive ctl spawn` starts with no --agent: the user's default if installed,
 *  else the first agent on this PATH. Valid after `ensureAgentCatalog()`. */
export function cliDefaultAgent(): string {
  return preferred ?? defaultAgent().id;
}

export function ensureAgentCatalog(): Promise<void> {
  loading ??= (async () => {
    try {
      const [{ loadAgents }, { BUILTIN_CATALOG, setCatalog, preferredAgent }, { NODE_PARTS }, core, { findBin }] = await Promise.all([
        import("@hivemind/agents/load"),
        import("@hivemind/agents"),
        import("@hivemind/agents/node"),
        import("@hivemind/core"),
        import("@hivemind/agents/discover"),
      ]);
      const repoRoot = await core.findRoot().catch(() => null);
      const settings = await core.readSettings().catch(() => null);
      const disabled = settings?.agents.disabled ?? [];
      const { defs } = await loadAgents({
        builtins: BUILTIN_CATALOG,
        repoRoot: repoRoot ?? undefined,
        disabled,
        nodeHalf: (id) => !!NODE_PARTS[id],
      });
      setCatalog(defs);
      preferred = preferredAgent(settings?.agents.defaultAgent, (d) => !!findBin(d.bin)).id;
    } catch { /* the compiled-in list stands */ }
  })();
  return loading;
}
