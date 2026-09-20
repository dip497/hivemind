/**
 * `hive views` — community workspace views (sandboxed plugins the desktop app
 * loads at runtime). Thin: validates + copies packages; nothing here runs them.
 *
 *   hive views list [--json]          user-installed + this repo's views, with load errors
 *   hive views install <dir>          validate hivemind-view.json, copy into $XDG_CONFIG_HOME/hivemind/views/<id>
 *   hive views install @owner/name    the same, from HiveHub, every file checked against its hash
 *   hive views remove <id>            delete a user-installed view (its saved layout stays, inert)
 *   hive views new <name>             a starter view in ./<name>, id @<your GitHub login>/<name>
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { defineCommand } from "citty";
import { HiveError, findRoot, installView, listInstalledViews, removeView } from "@hivemind/core";
import { err, ok } from "../format.js";
import { hcpCall } from "../hcp.js";
import { REGISTRY_NAME, stageFromRegistry } from "../registry.js";
import { starterFiles } from "../view-starter.js";

/** Ask a running app to re-read the view packages. False when no app is
 *  reachable (the change is picked up on the next start or when Settings ▸
 *  View is opened). */
async function rescanApp(): Promise<boolean> {
  try { await hcpCall("views.rescan", {}, 5000); return true; } catch { return false; }
}
const afterNote = (rescanned: boolean) => (rescanned ? "app rescanned" : "app not running or unreachable — restart it, or open Settings ▸ View");

const fail = (ctx: { json: boolean }, e: unknown, fallback: string): never =>
  err(ctx, e instanceof HiveError ? e.code : fallback, e instanceof Error ? e.message : String(e));

const listCmd = defineCommand({
  meta: { name: "list", description: "List installed views (user + this repo)" },
  args: { json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const root = await findRoot().catch(() => null);
      const views = await listInstalledViews(root);
      return ok(ctx, views, () =>
        views.length === 0
          ? "no views installed — `hive views install <dir>`"
          : views.map((v) => `${v.id.padEnd(16)} ${(v.manifest?.version ?? "-").padEnd(8)} ${v.source.padEnd(5)} ${v.error ? `DISABLED: ${v.error}` : (v.manifest?.name ?? "")}`).join("\n"),
      );
    } catch (e) { return fail(ctx, e, "list_failed"); }
  },
});

const installCmd = defineCommand({
  meta: { name: "install", description: "Install a view from a folder, or from HiveHub by @owner/name" },
  args: { dir: { type: "positional", required: true, description: "a folder holding hivemind-view.json, or @owner/name" }, json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const name = String(args.dir);
    let staged: string | null = null;
    // Errors exit the process (`err` does), so a `finally` would never run: discard by hand.
    const discard = async () => { if (staged) await rm(staged, { recursive: true, force: true }).catch(() => {}); };
    try {
      if (REGISTRY_NAME.test(name)) staged = (await stageFromRegistry(name, "view")).dir;
      const v = await installView(staged ?? name);
      await discard();
      const rescanned = await rescanApp();
      return ok(ctx, { ...v, rescanned }, () => `installed ${v.id} ${v.manifest?.version} → ${v.dir}; ${afterNote(rescanned)}`);
    } catch (e) { await discard(); return fail(ctx, e, "install_failed"); }
  },
});

const removeCmd = defineCommand({
  meta: { name: "remove", description: "Remove a user-installed view" },
  args: { id: { type: "positional", required: true }, json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      await removeView(String(args.id));
      const rescanned = await rescanApp();
      return ok(ctx, { id: String(args.id), rescanned }, () => `removed ${args.id}; ${afterNote(rescanned)}`);
    } catch (e) { return fail(ctx, e, "remove_failed"); }
  },
});

/** The GitHub login `gh` is signed in as: a view's scope is its publisher's account. */
function githubLogin(): string | null {
  try { return execFileSync("gh", ["api", "user", "--jq", ".login"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; } catch { return null; }
}

const newCmd = defineCommand({
  meta: { name: "new", description: "Start a view in ./<name>: builds on its own, the app serves the SDK" },
  args: {
    name: { type: "positional", required: true, description: "lowercase letters, digits and dashes" },
    owner: { type: "string", description: "your GitHub login (default: the account `gh` is signed in as)" },
    json: { type: "boolean" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const name = String(args.name);
    const owner = (args.owner ? String(args.owner) : githubLogin())?.replace(/^@/, "").toLowerCase() ?? null;
    if (!owner) return err(ctx, "no_owner", "pass --owner <your GitHub login>: a view is published under @login/name");
    if (!REGISTRY_NAME.test(`@${owner}/${name}`) || name.includes("--")) return err(ctx, "bad_name", `@${owner}/${name} is not a view id: lowercase letters, digits and single dashes`);
    const dir = path.resolve(name);
    if (existsSync(dir)) return err(ctx, "exists", `${dir} already exists`);
    for (const [f, body] of Object.entries(starterFiles(owner, name))) {
      await mkdir(path.dirname(path.join(dir, f)), { recursive: true });
      await writeFile(path.join(dir, f), body);
    }
    return ok(ctx, { id: `@${owner}/${name}`, dir }, () => `created @${owner}/${name} in ${dir}\n  cd ${name} && npm install && npm run dev\n  want an agent to build it? write your idea into PROMPT.md and hand it that file`);
  },
});

export const viewsCmd = defineCommand({
  meta: { name: "views", description: "Community workspace views (sandboxed plugins)" },
  subCommands: { list: listCmd, install: installCmd, remove: removeCmd, new: newCmd },
});
