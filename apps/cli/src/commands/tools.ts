/**
 * `hive tools` — what the tool plugins contribute: the tiles they can spawn, and the commands they
 * expose to you and to agents; the app's own, and the ones you added. One added is a kind of tile
 * loaded into the app, with the access the app has, so it is off until switched on
 * (`hive plugins enable tool:<id>`). Nothing here runs one.
 *
 *   hive tools list [--json]
 *   hive tools install <dir>     a folder holding hivemind-tool.json, copied into ~/.config/hivemind/tools
 *   hive tools remove <id>       tiles of it stay on their boards, showing it is missing
 *   hive tools new <name>        a starter in ./<name>, id <your GitHub login>/<name>
 */
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { defineCommand } from "citty";
import { readSettings } from "@hivemind/core";
import { BUNDLED_TOOL_PLUGINS } from "@hivemind/core/tool-plugins";
import { createToolRegistry } from "@hivemind/core/tool-registry";
import { TOOL_API_VERSION } from "@hivemind/core/tool-format";
import { installToolPackage, listToolPackages, removeToolPackage, TOOL_MANIFEST } from "@hivemind/core/tool-packages";
import { toolPreferences, type ToolsSettings } from "@hivemind/core/settings-schema";
import { err, ok } from "../format.js";
import { hcpCall } from "../hcp.js";
import { githubLogin } from "./views.js";
import { pluginBrief } from "../plugin-brief.js";

const NO_PLUGINS: ToolsSettings = { enabledPlugins: [], disabledTools: [] };

async function rescanApp(): Promise<boolean> {
  try { await hcpCall("settings.reload", {}, 5000); await hcpCall("tools.rescan", {}, 5000); return true; } catch { return false; }
}
const afterNote = (rescanned: boolean) => (rescanned ? "app updated" : "app not running — it loads them when it starts");
const fail = (ctx: { json: boolean }, e: unknown, code: string): never => err(ctx, code, e instanceof Error ? e.message : String(e));

const listCmd = defineCommand({
  meta: { name: "list", description: "List what each tool plugin contributes" },
  args: { json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const tools = await readSettings().then(toolPreferences).catch(() => NO_PLUGINS);
      const added = await listToolPackages();
      const loadable = added.filter((t) => !t.problem);
      const registry = createToolRegistry([...BUNDLED_TOOL_PLUGINS, ...loadable]);
      const resolved = registry.resolve(tools);
      const plugins = [
        ...[...new Set(registry.tools.map((t) => t.pluginId))].map((pluginId) => ({
          id: pluginId,
          added: loadable.some((t) => t.id === pluginId),
          problem: null as string | null,
          tiles: registry.tools
            .filter((t) => t.pluginId === pluginId)
            .map((t) => ({ id: t.id, label: t.label, tileKind: t.tileKind ?? null, available: resolved.availability(t.id).available })),
          commands: registry.commands
            .filter((c) => c.pluginId === pluginId)
            .map((c) => ({ id: c.id, summary: c.summary, readOnly: c.readOnly === true, cli: c.cli ?? null, available: resolved.commandAvailability(c.id).available })),
        })),
        ...added.filter((t) => t.problem).map((t) => ({ id: t.id, added: true, problem: t.problem, tiles: [], commands: [] })),
      ];
      return ok(ctx, plugins, () =>
        plugins.map((p) => [
          `${p.id}${p.added ? "  (you added this)" : ""}${p.problem ? `  does not load: ${p.problem}` : ""}`,
          ...p.tiles.map((t) => `  tile     ${t.label.padEnd(14)} ${t.available ? "" : "(off) "}${t.tileKind ?? ""}`),
          ...p.commands.map((c) => `  command  ${(c.cli ?? c.id).padEnd(14)} ${c.available ? "" : "(off) "}${c.readOnly ? "" : "[writes]"}`),
        ].join("\n")).join("\n\n"));
    } catch (e) {
      return fail(ctx, e, "list_failed");
    }
  },
});
const installCmd = defineCommand({
  meta: { name: "install", description: "Add a tool plugin from a folder" },
  args: { source: { type: "positional", required: true, description: `a folder holding ${TOOL_MANIFEST}` }, json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const t = await installToolPackage(path.resolve(String(args.source)));
      const rescanned = await rescanApp();
      return ok(ctx, { id: t.id, name: t.name, dir: t.dir, rescanned },
        () => `installed ${t.id} (${t.name}) → ${t.dir}; ${afterNote(rescanned)}\nIt is off: \`hive plugins enable tool:${t.id}\` if you trust who wrote it.`);
    } catch (e) { return fail(ctx, e, "install_failed"); }
  },
});

const removeCmd = defineCommand({
  meta: { name: "remove", description: "Remove a tool plugin you added" },
  args: { id: { type: "positional", required: true, description: "owner/name" }, json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      await removeToolPackage(String(args.id));
      const rescanned = await rescanApp();
      return ok(ctx, { id: String(args.id), rescanned }, () => `removed ${String(args.id)}; ${afterNote(rescanned)}`);
    } catch (e) { return fail(ctx, e, "remove_failed"); }
  },
});

/** The files of a starter tool plugin `name`, owned by `owner`. */
export function toolStarter(owner: string, name: string): Record<string, string> {
  const id = `${owner}/${name}`;
  const tileKind = `${owner}-${name}`.slice(0, 41);
  const manifest = {
    id, name: name.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase()), version: "0.1.0", apiVersion: TOOL_API_VERSION,
    description: "What it shows, in one line.", entry: "index.js", permissions: [], settings: [],
    tools: [{ key: name, label: name, description: "What its tile shows.", tileKind, size: { width: 720, height: 480 }, needsRepo: true, singleton: true }],
  };
  return {
    [TOOL_MANIFEST]: JSON.stringify(manifest, null, 2) + "\n",
    "index.js": STARTER_JS.replace("__KIND__", JSON.stringify(tileKind)),
    "README.md": `# ${manifest.name}\n\n${manifest.description}\n\nAdd it to the app and switch it on:\n\n\`\`\`bash\nhive tools install .\nhive plugins enable tool:${id}\n\`\`\`\n\nThen open it from a frame's **Open** menu.\n`,
    "PROMPT.md": pluginBrief("tool", id),
  };
}

const STARTER_JS = `// A tool plugin's tile, drawn by the app's own React, inside the app.
//   tile: this tile (id, kind, name, frameId)
//   hm:   the client a view has: frames, tiles, agents, commands, its settings and saved state
//   host: what only a tile has: its folder, programs run there, opening things beside it
import React, { useEffect, useState } from "hm-plugin://host/react.js";
import { Button } from "hm-plugin://host/sdk.js";

const h = React.createElement;

function Tile({ tile, host }) {
  const [branch, setBranch] = useState("…");
  const refresh = () => host.run("git", ["branch", "--show-current"]).then((r) => setBranch(r.stdout.trim() || "(no branch)"));
  useEffect(() => { void refresh(); }, []);
  return h("div", { style: { padding: 16, display: "grid", gap: 8 } },
    h("h3", { style: { margin: 0 } }, tile.name),
    h("p", null, "Branch: ", h("code", null, branch)),
    h(Button, { size: "sm", variant: "outline", onClick: refresh }, "Refresh"));
}

export default { tiles: { __KIND__: Tile } };
`;

const newCmd = defineCommand({
  meta: { name: "new", description: "Start a tool plugin in ./<name>" },
  args: { name: { type: "positional", required: true, description: "lowercase letters, digits and dashes" }, owner: { type: "string", description: "default: your GitHub login" }, json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const name = String(args.name);
    try {
      if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(name)) throw new Error(`"${name}" is not a name: lowercase letters, digits and dashes`);
      const owner = (args.owner ? String(args.owner) : githubLogin())?.replace(/^@/, "").toLowerCase() ?? null;
      if (!owner) throw new Error("say whose it is with --owner <github login> (gh is not signed in)");
      const dir = path.resolve(name);
      if (existsSync(dir)) throw new Error(`${dir} is already there`);
      await mkdir(dir, { recursive: true });
      try {
        for (const [file, text] of Object.entries(toolStarter(owner, name))) await writeFile(path.join(dir, file), text);
      } catch (e) { await rm(dir, { recursive: true, force: true }); throw e; }
      return ok(ctx, { id: `${owner}/${name}`, dir }, () => `started ${owner}/${name} in ${dir}\n  cd ${name} && hive tools install . && hive plugins enable tool:${owner}/${name}`);
    } catch (e) { return fail(ctx, e, "new_failed"); }
  },
});

export const toolsCmd = defineCommand({
  meta: { name: "tools", description: "Tiles and commands the tool plugins contribute; add, remove or start one" },
  subCommands: { list: listCmd, install: installCmd, remove: removeCmd, new: newCmd },
});
