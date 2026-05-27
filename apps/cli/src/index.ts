#!/usr/bin/env bun
/**
 * `hive` — filesystem-only markdown issue/task tracker for hivemind.
 *
 * Storage layout: see packages/hive-core/src/storage.ts.
 * Doc split:      AGENTS.md (pointer) → CLAUDE.md (source of truth).
 */
import { defineCommand, runMain } from "citty";
import { initCmd } from "./commands/init.js";
import { newCmd } from "./commands/new.js";
import { listCmd } from "./commands/list.js";
import { showCmd } from "./commands/show.js";
import { updateCmd } from "./commands/update.js";
import { closeCmd, reopenCmd } from "./commands/close.js";
import { taskCmd } from "./commands/task.js";
import { linkCmd } from "./commands/link.js";
import { agentCmd } from "./commands/agent.js";
import { resolveCmd } from "./commands/mention.js";
import { mcpStdioCmd } from "./commands/mcp.js";
import { readIssue, requireRoot } from "@hivemind/core";
import { err, ok, renderIssue } from "./format.js";
import { stripAt } from "./parse.js";

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
    version: "0.0.1",
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
    agent: agentCmd,
    resolve: resolveCmd,
    "mcp-stdio": mcpStdioCmd,
  },
});

// Silence unused-import warning for the show alias in @-shortcut path.
void readIssue;
void requireRoot;
void err;
void ok;
void renderIssue;
void stripAt;

preprocessArgv();
await runMain(main);
