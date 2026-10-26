/**
 * The "agentic stack" installer — the files that teach an agent how to drive a
 * hivemind workspace, shared by `hive init` / `hive add skill` (CLI) and the
 * desktop's "Work on this" (which installs before spawning). ONE implementation
 * so the two can't drift:
 *   - CLAUDE.md agentic section (marker-wrapped; re-applied idempotently)
 *   - .claude/skills/{hive-work,hive-workflow,hivemind,hive-browser}/SKILL.md
 *   - .claude/skills/<name>/ of the tool plugins on for the workspace (`./plugin-skills.ts`)
 *   - retirement of the old `.mcp.json` hive server entry (the MCP server is
 *     gone; a stale entry makes claude report a failed server on every start)
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import * as templates from "./templates.js";
import { isPluginOn, serviceWorkspaces } from "./plugin-settings.js";
import { HIVE_SKILL_NAMES, syncPluginSkills, type PluginSkillsReport, type PluginSkillSource } from "./plugin-skills.js";
import { readSettings } from "./settings.js";
import { listToolPackages } from "./tool-packages.js";

export interface AgenticReport {
  claudeAgentic: "appended" | "unchanged" | "replaced" | "created";
  /** Skills written or regenerated this run (empty = all current). */
  skills: string[];
  /** Whether a stale `hive` MCP server entry was removed from `.mcp.json`. */
  mcpRetired: boolean;
  /** The tool plugins' skills: what was written, removed, kept or refused. */
  pluginSkills: PluginSkillsReport;
}

const run = promisify(execFile);
const MARKER_RE = /<!--\s*hivemind:agentic:start\s*-->[\s\S]*?<!--\s*hivemind:agentic:end\s*-->\n?/;

/** Append/refresh the CLAUDE.md agentic section (wrapped in marker comments;
 *  re-running replaces just that section, preserving the rest). */
export async function installClaudeAgentic(cwd: string): Promise<AgenticReport["claudeAgentic"]> {
  const claudePath = path.join(cwd, "CLAUDE.md");
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
    await fs.writeFile(claudePath, `# CLAUDE.md\n\n(Project rules go here.)\n${templates.agenticClaudeAppend()}`, "utf8");
    return "created";
  }
}

/** The hive skills. The app owns them: an older copy is replaced by this version's, edits too; a
 *  skill of a person's own goes under another name. */
export const SKILLS: Record<string, () => string> = {
  "hive-work": () => templates.HIVE_WORK_SKILL,
  hivemind: () => templates.HIVEMIND_SKILL,
  "hive-browser": () => templates.hiveBrowserSkill(),
  "hive-workflow": () => templates.hiveWorkflowSkill(),
} satisfies Record<(typeof HIVE_SKILL_NAMES)[number], () => string>;

/** Writes the hive skills under `.claude/skills/` that differ from this version's; with `addMissing`
 *  false, only those already there. Returns the names written. */
async function writeSkills(cwd: string, addMissing: boolean): Promise<string[]> {
  const written: string[] = [];
  for (const [name, body] of Object.entries(SKILLS)) {
    const dir = path.join(cwd, ".claude", "skills", name);
    const file = path.join(dir, "SKILL.md");
    const existing = await fs.readFile(file, "utf8").catch(() => null);
    if (existing === null && !addMissing) continue;
    if (existing === body()) continue;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, body(), "utf8");
    written.push(name);
  }
  return written;
}

/** Install every hive skill under `.claude/skills/`. Returns the names written. */
export const installSkills = (cwd: string): Promise<string[]> => writeSkills(cwd, true);

/** Bring the hive skills a workspace already has up to this version, before an agent starts there;
 *  adds none. Returns the names written. */
export const refreshSkills = (cwd: string): Promise<string[]> => writeSkills(cwd, false);

const real = (p: string): Promise<string> => fs.realpath(p).catch(() => path.resolve(p));
const commonDir = async (dir: string): Promise<string | null> => {
  try {
    const { stdout } = await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: dir, encoding: "utf8", windowsHide: true });
    return stdout.trim() || null;
  } catch { return null; }
};

/** Whether a plugin's service drives the workspace in `cwd`: it is one picked for it, or a linked
 *  worktree of one (where an agent works an issue of it). */
async function drives(picked: string[], cwd: string): Promise<boolean> {
  if (!picked.length) return false;
  const here = await real(cwd);
  const all = await Promise.all(picked.map(real));
  if (all.includes(here)) return true;
  const mine = await commonDir(here);
  return !!mine && (await Promise.all(all.map(commonDir))).includes(mine);
}

/** The skills of the tool plugins on for the workspace in `cwd`: a plugin that is on, and, when it
 *  brings a service, whose service drives this workspace. `appRoot` holds the app's own plugins. */
export async function pluginSkillSources(cwd: string, appRoot?: string | null): Promise<PluginSkillSource[]> {
  const states = (await readSettings()).plugins.state;
  const out: PluginSkillSource[] = [];
  for (const p of await listToolPackages(appRoot)) {
    if (p.problem || !p.skills?.length || !isPluginOn(states, "tool", p, p.source === "app")) continue;
    if (p.service && !(await drives(serviceWorkspaces(states, p.id), cwd))) continue;
    out.push({ plugin: p.id, ...(p.version ? { version: p.version } : {}), dir: p.dir, skills: p.skills });
  }
  return out;
}

/** Install, update or remove the tool plugins' skills in the workspace in `cwd`, as the plugins on
 *  for it say. Safe mode (`HIVEMIND_SAFE_MODE=1`) loads no plugin, and changes none of their skills. */
export async function installPluginSkills(cwd: string, appRoot?: string | null): Promise<PluginSkillsReport> {
  if (process.env.HIVEMIND_SAFE_MODE === "1") return { installed: [], updated: [], removed: [], kept: [], refused: [] };
  return syncPluginSkills(cwd, await pluginSkillSources(cwd, appRoot));
}

/** Remove the retired `hive` MCP server from `.mcp.json` (keeps other servers;
 *  deletes the file when nothing is left). Returns true if it changed anything. */
export async function retireHiveMcpJson(cwd: string): Promise<boolean> {
  const file = path.join(cwd, ".mcp.json");
  let parsed: { mcpServers?: Record<string, { args?: unknown[] }> };
  try { parsed = JSON.parse(await fs.readFile(file, "utf8")); } catch { return false; }
  const hive = parsed.mcpServers?.hive;
  if (!hive || !Array.isArray(hive.args) || !hive.args.includes("mcp-stdio")) return false;
  delete parsed.mcpServers!.hive;
  if (Object.keys(parsed.mcpServers!).length === 0 && Object.keys(parsed).length === 1) {
    await fs.unlink(file);
  } else {
    await fs.writeFile(file, JSON.stringify(parsed, null, 2) + "\n", "utf8");
  }
  return true;
}

/** The whole stack, idempotent. */
export async function installAgenticStack(cwd: string): Promise<AgenticReport> {
  const claudeAgentic = await installClaudeAgentic(cwd);
  const skills = await installSkills(cwd);
  const mcpRetired = await retireHiveMcpJson(cwd);
  const pluginSkills = await installPluginSkills(cwd);
  return { claudeAgentic, skills, mcpRetired, pluginSkills };
}
