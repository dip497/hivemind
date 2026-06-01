/**
 * `hive workspace` — manage the cross-repo workspace registry.
 *
 *   hive workspace list              list every registered workspace
 *   hive workspace register          index the current repo's workspace
 *
 * The registry (prefix -> .hivemind root) is what lets `hive move` / `hive
 * relate` resolve an issue id in another repo.
 */
import { defineCommand } from "citty";
import {
  HiveError,
  listWorkspaces,
  registerWorkspace,
  requireRoot,
} from "@hivemind/core";
import { err, ok } from "../format.js";

const listCmd = defineCommand({
  meta: { name: "list", description: "List registered workspaces" },
  args: { json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const ws = await listWorkspaces({ persistPrune: true });
      return ok(ctx, ws, () =>
        ws.length === 0
          ? "no workspaces registered yet — run `hive workspace register` in a repo"
          : ws.map((w) => `${w.prefix.padEnd(12)} ${w.title.padEnd(24)} ${w.repo}`).join("\n"),
      );
    } catch (e) {
      const msg = e instanceof HiveError ? e.message : (e as Error).message;
      const code = e instanceof HiveError ? e.code : "list_failed";
      return err(ctx, code, msg);
    }
  },
});

const registerSubCmd = defineCommand({
  meta: { name: "register", description: "Index the current repo's workspace in the registry" },
  args: { json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const root = await requireRoot();
      const entry = await registerWorkspace(root);
      return ok(ctx, entry, () => `registered ${entry.prefix} → ${entry.repo}`);
    } catch (e) {
      const msg = e instanceof HiveError ? e.message : (e as Error).message;
      const code = e instanceof HiveError ? e.code : "register_failed";
      return err(ctx, code, msg);
    }
  },
});

export const workspaceCmd = defineCommand({
  meta: { name: "workspace", description: "Manage the cross-repo workspace registry" },
  subCommands: { list: listCmd, register: registerSubCmd },
});
