/**
 * Installers for hivemind's "agentic stack" — the pieces that teach a claude
 * agent how to drive this workspace:
 *   - `.mcp.json`        → the `hive` MCP server (issue tools + control plane)
 *   - `.claude/skills/hive-work/SKILL.md` → the workflow skill the agent loads
 *   - CLAUDE.md agentic section → prose pointing the agent at both
 *
 * `hive init` runs all three (agentic by default); `hive add mcp` / `hive add
 * skill` run one. Each installer is idempotent and reports what it did.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { templates } from "@hivemind/core";

export interface AgenticReport {
  claudeAgentic: "appended" | "unchanged" | "replaced" | "created";
  mcp: "created" | "merged" | "unchanged";
  skill: "created" | "unchanged";
}

/** Append/refresh the CLAUDE.md agentic section (wrapped in marker comments;
 *  re-running replaces just that section, preserving the rest). */
export async function installClaudeAgentic(cwd: string): Promise<AgenticReport["claudeAgentic"]> {
  const claudePath = path.join(cwd, "CLAUDE.md");
  const MARKER_RE = /<!--\s*hivemind:agentic:start\s*-->[\s\S]*?<!--\s*hivemind:agentic:end\s*-->\n?/;
  try {
    const existing = await fs.readFile(claudePath, "utf8");
    if (MARKER_RE.test(existing)) {
      const replaced = existing.replace(MARKER_RE, templates.agenticClaudeAppend().trim() + "\n");
      if (replaced === existing) return "unchanged";
      await fs.writeFile(claudePath, replaced, "utf8");
      return "replaced";
    }
    await fs.writeFile(claudePath, existing + templates.agenticClaudeAppend(), "utf8");
    return "appended";
  } catch {
    await fs.writeFile(
      claudePath,
      `# CLAUDE.md\n\n(Project rules go here.)\n${templates.agenticClaudeAppend()}`,
      "utf8",
    );
    return "created";
  }
}

/** Write/merge the `hive` MCP server into `.mcp.json` (keeps any other servers). */
export async function installHiveMcp(cwd: string, hiveRoot: string): Promise<AgenticReport["mcp"]> {
  const mcpPath = path.join(cwd, ".mcp.json");
  const hiveCliPath = await resolveHiveCli();
  const ourMcpJson = templates.mcpJson(hiveCliPath, hiveRoot);
  const ourMcp = JSON.parse(ourMcpJson) as { mcpServers: Record<string, unknown> };
  try {
    const existing = await fs.readFile(mcpPath, "utf8");
    let merged: { mcpServers?: Record<string, unknown> };
    try {
      merged = JSON.parse(existing) as { mcpServers?: Record<string, unknown> };
    } catch {
      merged = {};
    }
    const before = JSON.stringify(merged);
    merged.mcpServers = { ...(merged.mcpServers ?? {}), ...ourMcp.mcpServers };
    if (JSON.stringify(merged) === before) return "unchanged";
    await fs.writeFile(mcpPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
    return "merged";
  } catch {
    await fs.writeFile(mcpPath, ourMcpJson + "\n", "utf8");
    return "created";
  }
}

/** Write a skill to `.claude/skills/<name>/SKILL.md` (only if missing — never
 *  clobber a user's edits). Returns whether it created the file. */
async function writeSkillIfMissing(cwd: string, name: string, body: string): Promise<boolean> {
  const skillDir = path.join(cwd, ".claude", "skills", name);
  const skillPath = path.join(skillDir, "SKILL.md");
  try {
    await fs.stat(skillPath);
    return false;
  } catch {
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(skillPath, body, "utf8");
    return true;
  }
}

/** Install the hive agent skills — `hive-work` (issue execution contract) and
 *  `hive-workflow` (multi-agent orchestration). Each is written only if missing.
 *  Returns "created" if EITHER was newly written. */
export async function installHiveSkill(cwd: string): Promise<AgenticReport["skill"]> {
  const work = await writeSkillIfMissing(cwd, "hive-work", templates.HIVE_WORK_SKILL);
  const workflow = await writeSkillIfMissing(cwd, "hive-workflow", templates.hiveWorkflowSkill());
  return work || workflow ? "created" : "unchanged";
}

/** The full agentic stack: CLAUDE.md section + MCP + skill. */
export async function installAgenticFiles(cwd: string, hiveRoot: string): Promise<AgenticReport> {
  const claudeAgentic = await installClaudeAgentic(cwd);
  const mcp = await installHiveMcp(cwd, hiveRoot);
  const skill = await installHiveSkill(cwd);
  return { claudeAgentic, mcp, skill };
}

/** Best-effort find the `hive` binary on PATH; fall back to argv[1] (this
 *  process's entry script) so dev-source invocations work. */
export async function resolveHiveCli(): Promise<string> {
  const PATH = process.env.PATH ?? "";
  for (const dir of PATH.split(":").filter(Boolean)) {
    try {
      const p = path.join(dir, "hive");
      const st = await fs.stat(p);
      if (st.isFile() && (st.mode & 0o111) !== 0) return p;
    } catch {
      /* not here */
    }
  }
  const argv1 = process.argv[1];
  if (argv1) return path.resolve(argv1);
  return "hive";
}
