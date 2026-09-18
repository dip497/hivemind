/** `hive agents list|install|remove` — same loader as the app, so list shows what it loads. */
import { defineCommand } from "citty";
import { REGISTRY_NAME, stageFromRegistry } from "../registry.js";
import { findRoot, patchSettingsFile, readSettings } from "@hivemind/core";
import { BUILTIN_CATALOG } from "@hivemind/agents";
import { loadAgents, installAgent, removeAgent, AGENT_MANIFEST_FILE } from "@hivemind/agents/load";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import path from "node:path";
import { NODE_PARTS } from "@hivemind/agents/node";
import { err, ok } from "../format.js";
import { hcpCall } from "../hcp.js";

/** The id a package claims, read before anything is copied. Null when it is unreadable —
 *  installAgent reports the real reason. */
async function readAgentId(dir: string): Promise<string | null> {
  try { return /^id:\s*"?(@?[A-Za-z0-9][\w-]*(?:\/[A-Za-z0-9][\w-]*)?)"?\s*$/m.exec(await readFile(path.join(dir, AGENT_MANIFEST_FILE), "utf8"))?.[1] ?? null; }
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

/**
 * `owner/repo`, or `owner/repo/some/dir` — how every agent ecosystem addresses a plugin, and
 * the only sharing that works before any index exists: someone pastes a repository name.
 */
const REPO_SPEC = /^([A-Za-z0-9][\w.-]{0,38})\/([A-Za-z0-9][\w.-]{0,99})((?:\/[\w.-]+)*)$/;

/**
 * Fetch an agent package out of a public repository into a fresh folder.
 *
 * Nothing is pinned here — a repository's contents change, so there is no hash to check it
 * against, and saying so is more honest than implying otherwise. What stands in for it: only
 * `agent.yaml` and the files that manifest itself declares are fetched, each name already
 * validated as a plain one that cannot leave the folder; https only, no redirects; and the
 * install still refuses anything the manifest may not say.
 */
async function stageFromRepo(spec: string, ref: string): Promise<{ dir: string; from: string }> {
  const m = REPO_SPEC.exec(spec);
  if (!m) throw new Error(`"${spec}" is neither a folder on this machine nor an owner/repo`);
  const [, owner, repo, sub] = m;
  const base = new URL(`https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref)}${sub ?? ""}/`);
  const { readPluginFile, MAX_FILE } = await import("@hivemind/core/plugin-catalog");
  const dir = await mkdtemp(path.join(tmpdir(), "hm-agent-"));

  const grab = async (name: string): Promise<void> => {
    const body = await readPluginFile(new URL(name, base), MAX_FILE);
    await writeFile(path.join(dir, name), body);
  };
  await grab(AGENT_MANIFEST_FILE);
  // Its own manifest says which other files it ships; validation has already bounded those
  // names to plain ones, so this cannot be talked into fetching a path of someone's choosing.
  const { readAgentManifest } = await import("@hivemind/agents/load");
  const read = await readAgentManifest(path.join(dir, AGENT_MANIFEST_FILE), {
    source: "user", requireDirMatch: false, nodeHalf: () => false,
  });
  for (const asset of read.def?.assets ?? []) await grab(asset.file);
  return { dir, from: base.href };
}

const installCmd = defineCommand({
  meta: { name: "install", description: "Validate an agent package and copy it into the user agents dir" },
  args: {
    dir: { type: "positional", required: true, description: "a folder holding agent.yaml, @owner/name from HiveHub, or owner/repo[/dir] on GitHub" },
    replace: { type: "boolean", description: "allow it to take a built-in agent's id" },
    ref: { type: "string", description: "branch or tag to take it from (default: the default branch)" },
    yes: { type: "boolean", description: "install from a repository without reading what it does first" },
    json: { type: "boolean" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    let staged: string | null = null;
    // Errors exit the process (`err` does), so a `finally` would never run: discard by hand.
    const discard = async () => { if (staged) await rm(staged, { recursive: true, force: true }).catch(() => {}); };
    const stop = async (code: string, message: string) => { await discard(); return err(ctx, code, message); };
    try {
      // A folder is a folder; @owner/name is HiveHub; anything else is a repository someone named.
      let source = String(args.dir);
      let from: { where: string; pinned: boolean } | null = null;
      if (REGISTRY_NAME.test(source)) {
        const got = await stageFromRegistry(source, "agent");
        staged = source = got.dir;
        from = { where: `HiveHub, published from ${got.entry.source ?? "its repository"}`, pinned: true };
      } else if (!existsSync(path.join(source, AGENT_MANIFEST_FILE))) {
        const got = await stageFromRepo(source, args.ref ? String(args.ref) : "HEAD");
        staged = source = got.dir;
        from = { where: got.from, pinned: false };
      }
      // Downloaded, not handed over: say what it does, and let a person agree to it, before
      // any of it lands in the agents folder.
      if (from && !args.yes) {
        const { agentDisclosures } = await import("@hivemind/agents");
        const { readAgentManifest } = await import("@hivemind/agents/load");
        const read = await readAgentManifest(path.join(source, AGENT_MANIFEST_FILE), {
          source: "user", requireDirMatch: false, nodeHalf: () => false,
        });
        if (read.error || !read.def) return stop("invalid", read.error ?? "invalid agent manifest");
        return stop("install_unconfirmed", [
          `${read.def.label} (${read.def.id}) from ${from.where}`,
          `  runs ${[read.def.bin, ...(read.def.defaultArgs ?? [])].join(" ")}`,
          ...agentDisclosures(read.def).map((d) => `  ${d}`),
          from.pinned
            ? "Every file matches the hash HiveHub recorded. Re-run with --yes to install it."
            : "Nothing is pinned: a repository can change after you read this. Re-run with --yes to install it.",
        ].join("\n"));
      }
      // Taking a built-in's id means every ⌘\, toolbar click and `ctl spawn` runs this
      // instead. Legitimate, but never as a side effect of a command someone pasted.
      const id = await readAgentId(source);
      const builtin = id ? BUILTIN_CATALOG.find((d) => d.id === id) : undefined;
      if (builtin && !args.replace) {
        return stop("install_refused", `${id} is the id of the built-in ${builtin.label}; installing it would replace that agent everywhere. Re-run with --replace if that is what you want.`);
      }
      const a = await installAgent(source, { allowReserved: !!args.replace });
      await discard();
      const rescanned = await rescanApp();
      return ok(ctx, { id: a.id, dir: a.dir, rescanned }, () => `installed ${a.id} → ${a.dir}; ${afterNote(rescanned)}`);
    } catch (e) { await discard(); return fail(ctx, e, "install_failed"); }
  },
});

const validateCmd = defineCommand({
  meta: { name: "validate", description: "Check an agent package the way an install would, and show what a user will be told" },
  args: {
    dir: { type: "positional", required: true, description: "directory holding agent.yaml" },
    json: { type: "boolean" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const dir = String(args.dir);
      const { agentDisclosures, isGenericRuntime, RESERVED_AGENTS } = await import("@hivemind/agents");
      const { readAgentManifest } = await import("@hivemind/agents/load");
      // Exactly the checks a user's machine runs: nothing here is trusted because you wrote it.
      const read = await readAgentManifest(path.join(dir, AGENT_MANIFEST_FILE), {
        source: "user", requireDirMatch: false, nodeHalf: () => false,
      });
      if (read.error || !read.def) return err(ctx, "invalid", read.error ?? "invalid agent manifest");
      const def = read.def;

      // Things that load fine and still disappoint whoever installs it.
      const warnings: string[] = [];
      for (const asset of def.assets ?? []) {
        if (!existsSync(path.join(dir, asset.file))) warnings.push(`assets: ${asset.file} is declared but not in this folder`);
      }
      if (isGenericRuntime(def.bin)) {
        warnings.push(`bin: "${def.bin}" runs whatever it is given, so this agent is never added automatically — a person has to install it by hand`);
      }
      const reserved = RESERVED_AGENTS[def.id];
      if (reserved && reserved !== def.bin) warnings.push(`id: "${def.id}" is Hivemind's name for \`${reserved}\` — pick another id`);
      const does = agentDisclosures(def);
      if (does.length) warnings.push("this is never added automatically, because a person has to agree to what it does");

      return ok(ctx, { id: def.id, label: def.label, bin: def.bin, command: [def.bin, ...(def.defaultArgs ?? [])].join(" "), worker: def.caps.turnSignal, does, warnings }, () => [
        `${def.label} (${def.id}) — valid`,
        `  runs      ${[def.bin, ...(def.defaultArgs ?? [])].join(" ")}`,
        `  worker    ${def.caps.turnSignal ? "yes — other agents can delegate to it" : "no — it cannot report back"}`,
        does.length ? `  tells the user before installing:\n${does.map((d) => `    · ${d}`).join("\n")}` : "  tells the user before installing: nothing beyond running its own command",
        ...(warnings.length ? [`  warnings:\n${warnings.map((w) => `    ! ${w}`).join("\n")}`] : []),
      ].join("\n"));
    } catch (e) { return fail(ctx, e, "validate_failed"); }
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
  subCommands: { list: listCmd, validate: validateCmd, install: installCmd, remove: removeCmd },
});
