/**
 * `hive init` / `hive add skill` entry points for the agentic stack. The
 * implementation lives in @hivemind/core (agentic.ts) and is shared with the
 * desktop's "Work on this" installer, so the two can never drift.
 */
import type { PluginSkillsReport } from "@hivemind/core";
export { installAgenticStack, installClaudeAgentic, installPluginSkills, installSkills, retireHiveMcpJson, type AgenticReport } from "@hivemind/core";

/** What happened to the tool plugins' skills, as lines under the hive skills'; none when nothing did. */
export const pluginSkillLines = (r: PluginSkillsReport): string[] => [
  ...(r.installed.length ? [`  plugin skills installed: ${r.installed.join(", ")}`] : []),
  ...(r.updated.length ? [`  plugin skills updated: ${r.updated.join(", ")}`] : []),
  ...(r.removed.length ? [`  plugin skills removed: ${r.removed.join(", ")}`] : []),
  ...r.kept.map((k) => `  ! .claude/skills/${k.name} (${k.plugin}): ${k.why}`),
  ...r.refused.map((k) => `  ! ${k.plugin}'s skill ${k.name} not installed: ${k.why}`),
];
