/**
 * `hive views` — community workspace views (sandboxed plugins the desktop app
 * loads at runtime). Thin: validates + copies packages; nothing here runs them.
 *
 *   hive views list [--json]          user-installed + this repo's views, with load errors
 *   hive views install <dir>          validate hivemind-view.json, copy into $XDG_CONFIG_HOME/hivemind/views/<id>
 *   hive views remove <id>            delete a user-installed view (its saved layout stays, inert)
 */
import { defineCommand } from "citty";
import { HiveError, findRoot, installView, listInstalledViews, removeView } from "@hivemind/core";
import { err, ok } from "../format.js";
import { hcpCall } from "../hcp.js";

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
  meta: { name: "install", description: "Validate a view package and copy it into the user views dir" },
  args: { dir: { type: "positional", required: true, description: "package directory holding hivemind-view.json" }, json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const v = await installView(String(args.dir));
      const rescanned = await rescanApp();
      return ok(ctx, { ...v, rescanned }, () => `installed ${v.id} ${v.manifest?.version} → ${v.dir}; ${afterNote(rescanned)}`);
    } catch (e) { return fail(ctx, e, "install_failed"); }
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

export const viewsCmd = defineCommand({
  meta: { name: "views", description: "Community workspace views (sandboxed plugins)" },
  subCommands: { list: listCmd, install: installCmd, remove: removeCmd },
});
