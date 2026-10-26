/**
 * `hive add <piece>` — install one part of hivemind's agentic stack into the
 * current workspace, à la carte. `hive init` installs everything (agentic by
 * default); this adds (or refreshes) a single piece without re-initialising:
 *   - `hive add skill` → the hive skills in .claude/skills/ (hive-work,
 *     hive-workflow, hivemind, hive-browser), and the skills of the tool
 *     plugins on for this workspace
 */
import { defineCommand } from "citty";
import { installPluginSkills, installSkills, pluginSkillLines, retireHiveMcpJson } from "../agentic-install.js";
import { ok } from "../format.js";

const addSkillCmd = defineCommand({
  meta: {
    name: "skill",
    description: "Add the hive skills (hive-work, hive-workflow, hivemind, hive-browser) to .claude/skills/, replacing older copies, and the skills of the tool plugins on for this workspace",
  },
  args: { json: { type: "boolean", description: "Emit JSON" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const cwd = process.cwd();
    const written = await installSkills(cwd);
    const mcpRetired = await retireHiveMcpJson(cwd);
    const pluginSkills = await installPluginSkills(cwd);
    return ok(
      ctx,
      { skills: written, mcpRetired, pluginSkills, path: ".claude/skills/<name>/SKILL.md" },
      () =>
        [
          written.length ? `✓ skills written: ${written.join(", ")}` : `✓ skills up to date (.claude/skills/)`,
          `  agents load these to learn the hive issue + control-plane workflow (\`hive\`, \`hive ctl\`).`,
          ...(mcpRetired ? [`  removed the retired hive MCP server entry from .mcp.json`] : []),
          ...pluginSkillLines(pluginSkills),
        ].join("\n"),
    );
  },
});

export const addCmd = defineCommand({
  meta: {
    name: "add",
    description: "Add a piece of the agentic stack (skill) to this workspace",
  },
  subCommands: { skill: addSkillCmd },
});
