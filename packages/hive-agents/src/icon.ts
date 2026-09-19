import type { AgentIcon } from "./types.js";

/** The generic agent glyph — a small robot — for providers without a brand mark
 *  and for unknown ids. */
export const GENERIC_AGENT_ICON: AgentIcon = {
  viewBox: "0 0 16 16",
  attrs: { fill: "none" },
  body: '<rect x="2.5" y="4" width="11" height="8.5" rx="2" stroke="currentColor" stroke-width="1.2" /><circle cx="6" cy="8" r="1" fill="currentColor" /><circle cx="10" cy="8" r="1" fill="currentColor" /><path d="M8 4V2M5.5 12.5v1M10.5 12.5v1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />',
};
