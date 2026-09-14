/** `hive agents list|install|remove` — same loader as the app, so list shows what it loads. */
import { defineCommand } from "citty";
import { findRoot, patchSettingsFile, readSettings } from "@hivemind/core";
import { BUILTIN_CATALOG } from "@hivemind/agents";
import { loadAgents, installAgent, removeAgent, AGENT_MANIFEST_FILE } from "@hivemind/agents/load";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { NODE_PARTS } from "@hivemind/agents/node";
import { err, ok } from "../format.js";
import { hcpCall } from "../hcp.js";

/** The id a package claims, read before anything is copied. Null when it is unreadable —
 *  installAgent reports the real reason. */
async function readAgentId(dir: string): Promise<string | null> {
  try { return /^id:\s*"?([A-Za-z0-9][\w-]*)"?\s*$/m.exec(await readFile(path.join(dir, AGENT_MANIFEST_FILE), "utf8"))?.[1] ?? null; }
  catch { return null; }
}

/** Ask a running app to re-read its providers. False when none is reachable. */
async function rescanApp(): Promise<boolean> {
  try { await hcpCall("agents.rescan", {}, 5000); return true; } catch { return false; }
}
const afterNote = (rescanned: boolean): string =>
  rescanned ? "app rescanned" : "app not running or unreachable — restart it, or open Settings ▸ Agents";

const fail = (ctx: { json: boolean }, e: unknown, code: string): never =>
  err(ctx, code, e instanceof Error ? e.message : String(e));

async function scan(): Promise<Awaited<ReturnType<typeof loadAgents>>> {
  const repoRoot = await findRoot().catch(() => null);
  const disabled = await readSettings().then((s) => s.agents.disabled).catch(() => [] as string[]);
  return loadAgents({
    builtins: BUILTIN_CATALOG,
    repoRoot: repoRoot ?? undefined,
    disabled,
    nodeHalf: (id) => !!NODE_PARTS[id],
  });
}

const listCmd = defineCommand({
  meta: { name: "list", description: "List agent providers (built-in + user + this repo) and where each CLI was found" },
  args: {
    json: { type: "boolean" },
    found: { type: "boolean", description: "Only agents whose CLI is on this PATH" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const { findBin } = await import("@hivemind/agents/discover");
      const rows = (await scan()).loaded.map(({ id, source, error, disabled, file, def }) => ({
        id, source, error, disabled, file, found: def?.enabled ? findBin(def.bin) : null,
      })).filter((r) => !args.found || (r.found && !r.error && !r.disabled));
      return ok(ctx, rows, () => rows.length
        ? rows.map((a) => {
            const state = a.error ? `UNAVAILABLE: ${a.error}` : a.disabled ? "off" : "on";
            return `${a.id.padEnd(14)} ${a.source.padEnd(8)} ${state.padEnd(4)} ${a.found ?? "—"}`;
          }).join("\n")
        : "no agent CLIs found on this PATH");
    } catch (e) { return fail(ctx, e, "list_failed"); }
  },
});

const installCmd = defineCommand({
  meta: { name: "install", description: "Validate an agent package and copy it into the user agents dir" },
  args: {
    dir: { type: "positional", required: true, description: "directory holding agent.yaml" },
    replace: { type: "boolean", description: "allow it to take a built-in agent's id" },
    json: { type: "boolean" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      // Taking a built-in's id means every ⌘\, toolbar click and `ctl spawn` runs this
      // instead. Legitimate, but never as a side effect of a command someone pasted.
      const id = await readAgentId(String(args.dir));
      const builtin = id ? BUILTIN_CATALOG.find((d) => d.id === id) : undefined;
      if (builtin && !args.replace) {
        return err(ctx, "install_refused", `${id} is the id of the built-in ${builtin.label}; installing it would replace that agent everywhere. Re-run with --replace if that is what you want.`);
      }
      const a = await installAgent(String(args.dir));
      const rescanned = await rescanApp();
      return ok(ctx, { id: a.id, dir: a.dir, rescanned }, () => `installed ${a.id} → ${a.dir}; ${afterNote(rescanned)}`);
    } catch (e) { return fail(ctx, e, "install_failed"); }
  },
});

const removeCmd = defineCommand({
  meta: { name: "remove", description: "Remove a user-installed agent provider" },
  args: { id: { type: "positional", required: true }, json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const r = await removeAgent(String(args.id));
      // A removed catalog agent must not come back on the next start.
      const declined = await readSettings().then((s) => s.agents.declined).catch(() => [] as string[]);
      if (!declined.includes(r.id)) await patchSettingsFile([{ path: "agents.declined", value: [...declined, r.id] }]).catch(() => {});
      const rescanned = await rescanApp();
      return ok(ctx, { ...r, rescanned }, () => `removed ${r.id}; ${afterNote(rescanned)}`);
    } catch (e) { return fail(ctx, e, "remove_failed"); }
  },
});

export const agentsCmd = defineCommand({
  meta: { name: "agents", description: "Agent providers (manifest packages)" },
  subCommands: { list: listCmd, install: installCmd, remove: removeCmd },
});
