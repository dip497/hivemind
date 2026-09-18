/**
 * @hivemind/agents — the agent-provider catalog (browser-safe entry).
 * Daemon-side halves live behind `@hivemind/agents/node`.
 */
export * from "./types.js";
export * from "./catalog.js";
export * from "./detect-helpers.js";
export { GENERIC_AGENT_ICON } from "./icon.js";
// ./load.ts is node-only; import it from "@hivemind/agents/load".
export * from "./manifest.js";
export { RESERVED_AGENTS } from "./reserved.js";
export * from "./detect-rules.js";
export * from "./options.js";
