/**
 * @hivemind/agents — the agent-provider catalog (browser-safe entry).
 * Daemon-side halves live behind `@hivemind/agents/node`.
 */
export * from "./types.js";
export * from "./catalog.js";
export * from "./detect-helpers.js";
export { GENERIC_AGENT_ICON } from "./icon.js";
export { detectClaudeState, type ClaudeState } from "./providers/claude/state.js";
