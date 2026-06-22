/**
 * `hive add <piece>` — install one part of hivemind's agentic stack into the
 * current workspace, à la carte. `hive init` installs everything (agentic by
 * default); these add a single piece (or refresh it) without re-initialising:
 *   - `hive add mcp`   → the `hive` MCP server in .mcp.json
 *   - `hive add skill` → the hive-work claude skill in .claude/skills/
 */
import { defineCommand } from "citty";
import { findRoot } from "@hivemind/core";
import { installHiveMcp, installHiveSkill } from "../agentic-install.js";
import { err, ok } from "../format.js";

const addMcpCmd = defineCommand({
  meta: {
    name: "mcp",
    description: "Add the hive MCP server to this workspace's .mcp.json (idempotent)",
  },
  args: { json: { type: "boolean", description: "Emit JSON" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const cwd = process.cwd();
    const root = await findRoot(cwd);
    if (!root) {
      return err(ctx, "no_workspace", "no .hivemind/ found — run `hive init --prefix XX` first");
    }
    const mcp = await installHiveMcp(cwd, root);
    return ok(
      ctx,
      { mcp, path: ".mcp.json" },
      () =>
        [
          `✓ .mcp.json  ${mcp}  (hive MCP server)`,
          `  start claude in this dir — it auto-loads the hive tools.`,
        ].join("\n"),
    );
  },
});

const addSkillCmd = defineCommand({
  meta: {
    name: "skill",
    description: "Add the hive-work claude skill to .claude/skills/ (idempotent)",
  },
  args: { json: { type: "boolean", description: "Emit JSON" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const cwd = process.cwd();
    const skill = await installHiveSkill(cwd);
    return ok(
      ctx,
      { skill, path: ".claude/skills/hive-work/SKILL.md" },
      () =>
        [
          `✓ skill  ${skill}  (.claude/skills/hive-work/SKILL.md)`,
          skill === "unchanged"
            ? `  already present — left your edits intact.`
            : `  claude loads this skill to learn the hive issue + control-plane workflow.`,
        ].join("\n"),
    );
  },
});

export const addCmd = defineCommand({
  meta: {
    name: "add",
    description: "Add a piece of the agentic stack (mcp / skill) to this workspace",
  },
  subCommands: { mcp: addMcpCmd, skill: addSkillCmd },
});
