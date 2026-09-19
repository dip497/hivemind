/**
 * Generate `.hivemind/.agent.md` — short, scannable context the AI agent
 * reads on startup (via the CLAUDE.md include). Regenerated on every issue
 * change by the CLI; ignored by git (in .gitignore).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { listIssues, readConfig } from "./storage.js";
import { filterIssues } from "./query.js";
import { availableCommands } from "./tool-plugins.js";
import type { ToolsSettings } from "./settings-schema.js";

const HEADER = `# .agent.md — auto-generated context

This file is regenerated whenever the issue tracker changes. Do not edit by hand.
See \`hive --help\` for commands. To reference an issue, use \`@<ID>\` format
(e.g. \`@PAY-118\`); call \`hive show <ID>\` for the full body.

`;

export interface AgentContextOptions {
  /** Only include issues in these states. Defaults to active states. */
  includeStates?: Array<
    "backlog" | "todo" | "in_progress" | "in_review" | "done" | "cancelled"
  >;
  /** The user's tool settings, so an enabled plugin's commands are listed too.
   *  Without them only the built-ins are, which is every command that ships. */
  tools?: ToolsSettings;
}

export async function buildAgentContext(
  root: string,
  opts: AgentContextOptions = {}
): Promise<string> {
  const cfg = await readConfig(root);
  const all = await listIssues(root);
  const states = opts.includeStates ?? ["todo", "in_progress", "in_review"];
  const active = filterIssues(all, { state: states });

  const lines: string[] = [HEADER.trim(), ""];
  lines.push(`## Project`);
  lines.push("");
  lines.push(`- Prefix: \`${cfg.prefix}\``);
  lines.push(`- Next ID: \`${cfg.prefix}-${cfg.next_id}\``);
  lines.push(
    `- Detected agents: ${
      Object.keys(cfg.agents).length === 0
        ? "_(none — run `hive detect-agents`)_"
        : Object.keys(cfg.agents).join(", ")
    }`
  );
  lines.push("");

  // Group by state.
  for (const state of states) {
    const items = active.filter((i) => i.state === state);
    if (items.length === 0) continue;
    lines.push(`## ${prettyState(state)} (${items.length})`);
    lines.push("");
    for (const i of items) {
      const labels = i.labels.length > 0 ? ` [${i.labels.join(", ")}]` : "";
      const a = i.assignee ? ` · @${i.assignee.id}` : "";
      const gh = i.github ? ` · gh#${i.github}` : "";
      const child = i.parent ? ` · ↳ ${i.parent}` : "";
      lines.push(`- \`@${i.id}\` — ${i.title}${labels}${a}${gh}${child}`);
    }
    lines.push("");
  }

  // Generated from the plugin registry: a plugin that contributes commands is
  // discoverable here, which is the only way an agent learns it has them.
  lines.push(`## Commands`);
  lines.push("");
  lines.push("```");
  for (const command of availableCommands(opts.tools ?? { enabledPlugins: [], disabledTools: [] })) {
    if (command.cli) lines.push(command.cli);
  }
  lines.push("```");

  return lines.join("\n") + "\n";
}

function prettyState(s: string): string {
  switch (s) {
    case "in_progress":
      return "In Progress";
    case "in_review":
      return "In Review";
    case "todo":
      return "Todo";
    case "backlog":
      return "Backlog";
    case "done":
      return "Done";
    case "cancelled":
      return "Cancelled";
    default:
      return s;
  }
}

export async function writeAgentContext(
  root: string,
  opts?: AgentContextOptions
): Promise<string> {
  const content = await buildAgentContext(root, opts);
  const p = path.join(root, ".agent.md");
  await fs.writeFile(p, content, "utf8");
  return p;
}
