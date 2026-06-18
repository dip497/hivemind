#!/usr/bin/env bun
/**
 * `hive` — filesystem-only markdown issue/task tracker for hivemind.
 *
 * Storage layout: see packages/hive-core/src/storage.ts.
 * Doc split:      AGENTS.md (pointer) → CLAUDE.md (source of truth).
 */
import { defineCommand, runMain } from "citty";
import pkg from "../package.json" with { type: "json" };
import { initCmd } from "./commands/init.js";
import { newCmd } from "./commands/new.js";
import { listCmd } from "./commands/list.js";
import { showCmd } from "./commands/show.js";
import { updateCmd } from "./commands/update.js";
import { closeCmd, reopenCmd } from "./commands/close.js";
import { taskCmd } from "./commands/task.js";
import { linkCmd } from "./commands/link.js";
import { relateCmd } from "./commands/relate.js";
import { moveCmd } from "./commands/move.js";
import { workspaceCmd } from "./commands/workspace.js";
import { agentCmd } from "./commands/agent.js";
import { upgradeCmd } from "./commands/upgrade.js";
import { resolveCmd } from "./commands/mention.js";
import { mcpStdioCmd } from "./commands/mcp.js";
import { ctlCmd } from "./commands/ctl.js";

/**
 * Intercept `hive @ID` BEFORE citty sees argv — citty treats unknown
 * positional commands as errors and short-circuits. Rewriting argv to
 * `hive show @ID` keeps the @ shortcut working without subclassing citty.
 */
function preprocessArgv(): void {
  const argv = process.argv.slice(2);
  if (argv.length > 0 && argv[0]!.startsWith("@")) {
    process.argv = [process.argv[0]!, process.argv[1]!, "show", ...argv];
  }
}

const main = defineCommand({
  meta: {
    name: "hive",
    version: pkg.version,
    description:
      "Markdown-only issue/task tracker (filesystem-backed). See AGENTS.md / CLAUDE.md.",
  },
  subCommands: {
    init: initCmd,
    new: newCmd,
    list: listCmd,
    show: showCmd,
    update: updateCmd,
    close: closeCmd,
    reopen: reopenCmd,
    task: taskCmd,
    link: linkCmd,
    relate: relateCmd,
    move: moveCmd,
    workspace: workspaceCmd,
    agent: agentCmd,
    upgrade: upgradeCmd,
    resolve: resolveCmd,
    "mcp-stdio": mcpStdioCmd,
    ctl: ctlCmd,
  },
});

preprocessArgv();
await runMain(main);
