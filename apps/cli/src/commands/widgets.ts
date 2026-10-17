/**
 * `hive widgets` — the widgets you can put in a workspace: the app's own and the ones you added.
 * Thin: validates and copies packages (`@hivemind/core/widgets`); nothing here runs them.
 *
 *   hive widgets list [--json]
 *   hive widgets install <dir>        a folder holding widget.json, copied into ~/.config/hivemind/widgets
 *   hive widgets install @owner/name  the same, from HiveHub, every file checked against its hash
 *   hive widgets remove <id>          what each placed one holds stays on its board
 *   hive widgets new <name>           a starter in ./<name>, id @<your GitHub login>/<name>
 */
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { defineCommand } from "citty";
import { installWidget, listWidgets, removeWidget } from "@hivemind/core/widgets";
import { err, ok } from "../format.js";
import { driveCall } from "../drive.js";
import { REGISTRY_NAME, stageFromRegistry } from "../registry.js";
import { githubLogin } from "./views.js";
import { WIDGET_TYPES } from "@hivemind/core/widget-api";
import { pluginBrief } from "../plugin-brief.js";

/** Ask a running app to list the widgets again. False when no app is reachable. */
async function rescanApp(): Promise<boolean> {
  try { await driveCall("widgets.rescan", [], 5000); return true; } catch { return false; }
}
const afterNote = (rescanned: boolean) => (rescanned ? "app updated" : "app not running — it lists them when it starts");
const fail = (ctx: { json: boolean }, e: unknown, code: string): never => err(ctx, code, e instanceof Error ? e.message : String(e));

const listCmd = defineCommand({
  meta: { name: "list", description: "List the widgets: the app's own and the ones you added" },
  args: { json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const rows = (await listWidgets()).map((w) => ({ id: w.id, name: w.name, version: w.version ?? null, builtin: !!w.builtin, code: w.code !== "", permissions: w.permissions, dir: w.dir ?? null }));
      return ok(ctx, rows, () => rows.map((w) => `${w.id.padEnd(24)} ${(w.version ?? "-").padEnd(8)} ${w.name}${w.builtin ? "  (comes with the app)" : ""}`).join("\n"));
    } catch (e) { return fail(ctx, e, "list_failed"); }
  },
});

const installCmd = defineCommand({
  meta: { name: "install", description: "Add a widget from a folder, or from HiveHub by @owner/name" },
  args: { source: { type: "positional", required: true, description: "a folder holding widget.json, or @owner/name" }, json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const name = String(args.source);
    let staged: string | null = null;
    // Errors exit the process (`err` does), so a `finally` would never run: discard by hand.
    const discard = async () => { if (staged) await rm(staged, { recursive: true, force: true }).catch(() => {}); };
    try {
      const fromHub = REGISTRY_NAME.test(name);
      if (fromHub) staged = (await stageFromRegistry(name, "widget")).dir;
      const w = await installWidget(staged ?? name, fromHub ? name : undefined);
      await discard();
      const rescanned = await rescanApp();
      return ok(ctx, { id: w.id, name: w.name, dir: w.dir, rescanned }, () => `installed ${w.id} (${w.name}) → ${w.dir}; ${afterNote(rescanned)}`);
    } catch (e) { await discard(); return fail(ctx, e, "install_failed"); }
  },
});

const removeCmd = defineCommand({
  meta: { name: "remove", description: "Remove a widget you added" },
  args: { id: { type: "positional", required: true }, json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      await removeWidget(String(args.id));
      const rescanned = await rescanApp();
      return ok(ctx, { id: String(args.id), rescanned }, () => `removed ${args.id}; ${afterNote(rescanned)}`);
    } catch (e) { return fail(ctx, e, "remove_failed"); }
  },
});

/** A widget that works as written: a counter with a button, kept with the workspace. */
function starter(owner: string, name: string): Record<string, string> {
  const title = name.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
  return {
    "widget.json": JSON.stringify({
      id: `@${owner}/${name}`, name: title, version: "0.1.0", description: "Counts presses.", icon: "icon.svg",
      options: [{ id: "step", label: "Step", type: "number", min: 1, max: 100, default: 1 }],
    }, null, 2) + "\n",
    "widget.js": `/// <reference path="./hive.d.ts" />
// Runs in a worker the app starts for each one placed. \`hive\` is its whole API (hive.d.ts).
const draw = () => hive.render({ type: "stack", children: [
  { type: "number", value: hive.state?.n ?? 0, label: "presses" },
  { type: "button", label: "Press", action: "inc" },
] });

hive.on("start", draw);
hive.on("action", (a) => {
  if (a === "inc") { hive.setState({ n: (hive.state?.n ?? 0) + Number(hive.options.step ?? 1) }); draw(); }
});
`,
    "hive.d.ts": WIDGET_TYPES,
    "jsconfig.json": JSON.stringify({ compilerOptions: { allowJs: true, checkJs: true, noEmit: true, target: "es2022", lib: ["es2022", "webworker"] }, include: ["*.js", "*.d.ts"] }, null, 2) + "\n",
    "icon.svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="3"/><path d="M8 12h8"/><path d="M12 8v8"/></svg>\n',
    "README.md": `# ${title}\n\nCounts presses. Shown on its HiveHub page and in the app before anyone installs it: say what it does and what it asks for.\n`,
    "PROMPT.md": pluginBrief("widget", `@${owner}/${name}`),
  };
}

const newCmd = defineCommand({
  meta: { name: "new", description: "Start a widget in ./<name>, ready to add and to publish" },
  args: {
    name: { type: "positional", required: true, description: "lowercase letters, digits and dashes" },
    owner: { type: "string", description: "your GitHub login (default: the account `gh` is signed in as)" },
    json: { type: "boolean" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const name = String(args.name);
    const owner = (args.owner ? String(args.owner) : githubLogin())?.replace(/^@/, "").toLowerCase() ?? null;
    if (!owner) return err(ctx, "no_owner", "pass --owner <your GitHub login>: a widget is published under @login/name");
    if (!REGISTRY_NAME.test(`@${owner}/${name}`) || name.includes("--")) return err(ctx, "bad_name", `@${owner}/${name} is not a widget id: lowercase letters, digits and single dashes`);
    const dir = path.resolve(name);
    if (existsSync(dir)) return err(ctx, "exists", `${dir} already exists`);
    await mkdir(dir, { recursive: true });
    for (const [f, body] of Object.entries(starter(owner, name))) await writeFile(path.join(dir, f), body);
    return ok(ctx, { id: `@${owner}/${name}`, dir }, () => `created @${owner}/${name} in ${dir}\n  hive widgets install ${name}    then add it from the toolbar's Add menu\n  hivehub publish ${name}          once it is pushed\n  want an agent to build it? write your idea into PROMPT.md and hand it that file`);
  },
});

export const widgetsCmd = defineCommand({
  meta: { name: "widgets", description: "Widgets: list, add from a folder or HiveHub, remove, start one" },
  subCommands: { list: listCmd, install: installCmd, remove: removeCmd, new: newCmd },
});
