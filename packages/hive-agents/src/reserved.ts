/**
 * Agent ids Hivemind has shipped, and the CLI each one launches.
 *
 * An id is how a user recognises an agent: the button says "Gemini" and they expect the
 * gemini they installed. Which agents ship in the box is a product choice that changes —
 * so the reservation cannot be "whatever is bundled today", or unbundling one would open
 * its name to a cloned repository or a hostile index. The id stays ours; what a manifest
 * may not do is take the name and point it at a different command.
 */
export const RESERVED_AGENTS: Readonly<Record<string, string>> = {
  "aider": "aider",
  "amp": "amp",
  "antigravity": "agy",
  "auggie": "auggie",
  "claude": "claude",
  "cline": "cline",
  "codex": "codex",
  "continue": "cn",
  "copilot": "copilot",
  "crush": "crush",
  "cursor": "cursor-agent",
  "droid": "droid",
  "gemini": "gemini",
  "grok": "grok",
  "hermes": "hermes",
  "kimi": "kimi",
  "kiro": "kiro-cli",
  "mistral-vibe": "vibe",
  "openclaw": "openclaw",
  "opencode": "opencode",
  "openhands": "openhands",
  "pi": "pi",
  "qwen-code": "qwen",
};
