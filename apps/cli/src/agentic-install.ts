/**
 * `hive init` / `hive add skill` entry points for the agentic stack. The
 * implementation lives in @hivemind/core (agentic.ts) and is shared with the
 * desktop's "Work on this" installer, so the two can never drift.
 */
export { installAgenticStack, installClaudeAgentic, installSkills, retireHiveMcpJson, type AgenticReport } from "@hivemind/core";
