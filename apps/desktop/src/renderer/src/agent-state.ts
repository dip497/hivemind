/**
 * Multi-agent terminal-state detection by screen scraping — ported from herdr
 * (github.com/ogulcancelik/herdr `src/detect.rs`, AGPL-3.0). herdr is a Rust
 * agent multiplexer; its per-agent output heuristics are battle-tested across
 * 15 CLI agents. We feed xterm's rendered viewport instead of a terminal tail
 * snapshot and return hivemind's UI status buckets.
 *
 * The catalogued providers' detectors live with their defs (@hivemind/agents);
 * claude's distinguishes permission vs. question, every other agent collapses
 * both into "blocked". The detectors for agents hivemind recognises but does
 * not spawn stay here.
 */
import { BRAILLE, CATALOG, agentById, cursorWordActive, hasBrailleSpinner, type AgentState, type TileStatus } from "@hivemind/agents";

/** An agent id: a catalogued provider ("claude", "codex", …) or one of the
 *  recognised-but-unspawnable herdr agents below. */
export type Agent = string;
export type { AgentState, TileStatus };

/** Agents hivemind RECOGNISES for status scraping but does not spawn (no
 *  provider def): the herdr-ported detectors below. Catalogued providers carry
 *  their own aliases + detector in their def. */
const EXTRA_ALIASES: Record<string, Agent> = {
  cursor: "cursor",
  "cursor-agent": "cursor",
  agy: "antigravity",
  antigravity: "antigravity",
  "antigravity-cli": "antigravity",
  cline: "cline",
  copilot: "copilot",
  "github-copilot": "copilot",
  ghcs: "copilot",
  kimi: "kimi",
  amp: "amp",
  "amp-local": "amp",
  grok: "grok",
  "grok-build": "grok",
  hermes: "hermes",
  "hermes-agent": "hermes",
};

const ALIASES: Record<string, Agent> = (() => {
  const out: Record<string, Agent> = { ...EXTRA_ALIASES };
  for (const d of CATALOG) {
    out[d.id] = d.id;
    out[d.bin] = d.id;
    for (const alias of d.aliases ?? []) out[alias] = d.id;
  }
  return out;
})();

/**
 * Identify which agent a tile is running from its spawn command. Strips a path
 * (`/usr/local/bin/claude` → `claude`) and matches known aliases. Returns null
 * for plain shells / unknown programs (no agent indicator shown).
 */
export function identifyAgent(cmd: string): Agent | null {
  const first = cmd.trim().split(/\s+/)[0] ?? "";
  const base = first.split("/").pop()!.toLowerCase();
  return ALIASES[base] ?? null;
}

// --- shared helpers live in @hivemind/agents (detect-helpers.ts) ------------
// The catalogued providers' detectors live with their provider def; the
// herdr-ported detectors for agents hivemind recognises but does not spawn
// (cursor, antigravity, cline, copilot, kimi, amp, grok, hermes) stay here.

// --- per-agent detectors --------------------------------------------------




function detectCursor(content: string): AgentState {
  const lower = content.toLowerCase();
  if (
    lower.includes("waiting for approval") ||
    lower.includes("run this command?") ||
    lower.includes("(y) (enter)") ||
    lower.includes("keep (n)") ||
    lower.includes("skip (esc or n)")
  )
    return "blocked";
  const blockedLine = content.split("\n").some((line) => {
    const l = line.trim().toLowerCase();
    return (
      l.includes("(y)") &&
      (l.includes("allow") || l.includes("run (once)") || l.includes("→ run") || l.startsWith("run "))
    );
  });
  if (blockedLine) return "blocked";
  if (lower.includes("ctrl+c to stop")) return "working";
  const spinner = content.split("\n").some((line) => {
    const trimmed = line.trimStart();
    const first = trimmed.charAt(0);
    if (first === "⬡" || first === "⬢") return cursorWordActive(trimmed.slice(1));
    if (BRAILLE.test(first)) return cursorWordActive(trimmed.replace(/^[⠀-⣿]+/, ""));
    return false;
  });
  return spinner ? "working" : "idle";
}

function detectAntigravity(content: string): AgentState {
  const lower = content.toLowerCase();
  const req = lower.includes("requesting permission for:");
  const q = lower.includes("do you want to proceed?");
  const controls = lower.includes("tab amend") && lower.includes("edit command");
  if (req && (q || controls)) return "blocked";
  const spinner = content.split("\n").some((line) => {
    const trimmed = line.trimStart();
    if (!BRAILLE.test(trimmed.charAt(0))) return false;
    return cursorWordActive(trimmed.replace(/^[⠀-⣿]+/, ""));
  });
  if (spinner) return "working";
  const bottom = content
    .split("\n")
    .reverse()
    .filter((l) => l.trim() !== "")
    .slice(0, 5);
  const tasks = bottom.some((line) => {
    const l = line.trim().toLowerCase();
    if (!l.includes("/tasks")) return false;
    const m = l.match(/(\d+)\s+task/);
    return m ? Number(m[1]) > 0 : false;
  });
  return tasks ? "working" : "idle";
}

function detectCline(content: string): AgentState {
  const lower = content.toLowerCase();
  if (lower.includes("let cline use this tool")) return "blocked";
  if ((lower.includes("[act mode]") || lower.includes("[plan mode]")) && lower.includes("yes"))
    return "blocked";
  if (lower.includes("cline is ready for your message")) return "idle";
  return "working"; // cline defaults to working
}


function detectCopilot(content: string): AgentState {
  const lower = content.toLowerCase();
  if (lower.includes("│ do you want")) return "blocked";
  if (lower.includes("confirm with") && lower.includes("enter")) return "blocked";
  if (lower.includes("esc to cancel")) return "working";
  return "idle";
}

function detectKimi(content: string): AgentState {
  const lower = content.toLowerCase();
  if (
    lower.includes("allow?") ||
    lower.includes("confirm?") ||
    lower.includes("approve?") ||
    lower.includes("proceed?") ||
    lower.includes("[y/n]") ||
    lower.includes("(y/n)")
  )
    return "blocked";
  if (
    lower.includes("thinking") ||
    lower.includes("processing") ||
    lower.includes("generating") ||
    lower.includes("waiting for response") ||
    lower.includes("ctrl+c to cancel") ||
    lower.includes("ctrl-c to cancel")
  )
    return "working";
  return "idle";
}



function detectAmp(content: string): AgentState {
  const lower = content.toLowerCase();
  const waiting = lower.includes("waiting for approval");
  const header =
    lower.includes("invoke tool") ||
    lower.includes("run this command?") ||
    lower.includes("allow editing file:") ||
    lower.includes("allow creating file:") ||
    lower.includes("confirm tool call");
  const actions =
    lower.includes("approve") &&
    (lower.includes("allow all for this session") ||
      lower.includes("allow all for every session") ||
      lower.includes("allow file for every session") ||
      lower.includes("deny with feedback"));
  if (actions && (waiting || header)) return "blocked";
  if (lower.includes("esc to cancel")) return "working";
  return "idle";
}

function detectGrok(content: string): AgentState {
  const lower = content.toLowerCase();
  if (
    lower.includes("use ← → to choose permission whitelist scope") ||
    lower.includes("yes, proceed") ||
    lower.includes("no, reject") ||
    lower.includes("ctrl+o:yolo") ||
    lower.includes(":scope")
  )
    return "blocked";
  if (
    hasBrailleSpinner(content) &&
    (lower.includes("waiting") ||
      lower.includes("run ") ||
      lower.includes("read ") ||
      lower.includes("search ") ||
      lower.includes("list "))
  )
    return "working";
  if (lower.includes("ctrl+c:cancel") && lower.includes("ctrl+enter:interject")) return "working";
  return "idle";
}

function detectHermes(content: string): AgentState {
  const lower = content.toLowerCase();
  const options =
    lower.includes("allow once") && lower.includes("allow for this session") && lower.includes("deny");
  const controls =
    lower.includes("enter to confirm") ||
    lower.includes("↑/↓ to select") ||
    lower.includes("show full command");
  if ((lower.includes("dangerous command") || options) && controls) return "blocked";
  if (lower.includes("msg=interrupt") || lower.includes("ctrl+c cancel")) return "working";
  return "idle";
}

/** herdr detectors for the recognised-but-unspawnable agents. Catalogued
 *  providers are dispatched to their def's detector (detectAgentState). */
const EXTRA_DETECTORS: Record<string, (c: string) => AgentState> = {
  cursor: detectCursor,
  antigravity: detectAntigravity,
  cline: detectCline,
  copilot: detectCopilot,
  kimi: detectKimi,
  amp: detectAmp,
  grok: detectGrok,
  hermes: detectHermes,
};

/** herdr three-state detection for a known non-claude agent (a catalogued
 *  provider's detector collapses permission/question into "blocked"). */
export function detectAgentState(agent: Agent, screen: string): AgentState {
  const d = agentById(agent);
  if (d) { const t = d.detect(screen); return t === "permission" || t === "question" ? "blocked" : t; }
  return EXTRA_DETECTORS[agent]?.(screen) ?? "idle";
}

/**
 * Claude briefly renders its idle prompt BETWEEN tool calls — a sub-second blip
 * that the raw scrape reads as "idle" before work resumes. Left alone that blip
 * fires a false "finished" notification. Hold a working→idle flip for
 * CLAUDE_WORKING_HOLD_MS: if Claude was working that recently, keep reporting
 * working until it has been genuinely quiet for the full window. Set above the
 * 1200ms scan interval so "finished" needs a second confirming idle scan — one
 * lone idle poll is treated as a between-tool blip, not completion. claude-only
 * (other detectors are already steady). `lastWorkingAt.t` mutates across polls.
 */
export const CLAUDE_WORKING_HOLD_MS = 2000;

export function stabilizeClaudeStatus(
  prev: TileStatus,
  raw: TileStatus,
  now: number,
  lastWorkingAt: { t: number | null },
): TileStatus {
  if (raw === "working") {
    lastWorkingAt.t = now;
    return "working";
  }
  // Needs-human states are authoritative — never hold them back.
  if (raw === "permission" || raw === "question" || raw === "blocked") return raw;
  if (raw === "idle" && prev === "working") {
    if (lastWorkingAt.t !== null && now - lastWorkingAt.t < CLAUDE_WORKING_HOLD_MS) {
      return "working";
    }
    return "idle";
  }
  return raw;
}

/**
 * Agents set the terminal window title (OSC 0/2) to a short summary of what
 * they're doing — claude writes a live task title ("Refactor auth", "Fixing
 * the flaky test"). We surface it as the tile's session name. Normalize the raw
 * OSC string: drop control chars, collapse whitespace, trim, cap length. Returns
 * "" for anything empty/meaningless so callers can fall back.
 */
export function normalizeAgentTitle(raw: string): string {
  return Array.from((raw ?? "").replace(/\s+/g, " ")) // tabs/newlines → space FIRST
    .filter((ch) => ch >= " " && ch !== "\x7f") // then strip C0/C1 controls + DEL
    .join("")
    .trim()
    // Strip a leading status glyph + separator claude prepends to the window title
    // while working (e.g. "✳ Fix the bug" / "· Fix the bug") — our own status pill
    // conveys working/idle, so the displayed name should be just the task. Only
    // decorative glyphs (stars/bullets/dots) + space; brackets/parens are kept.
    .replace(/^[\s·•∙‣⁃*✶✱✲✳✴✻✽✦✧★☆●○◦◌◆◇]+/u, "")
    .slice(0, 80)
    .trim();
}

/**
 * One call → the UI status bucket for any agent. A provider whose detector
 * distinguishes permission/question keeps them; the rest map to "blocked".
 */
export function detectTileStatus(agent: Agent, screen: string): TileStatus {
  // A catalogued provider's detector already returns the UI bucket (claude's
  // keeps permission/question); the herdr extras return the three-state model.
  return agentById(agent)?.detect(screen) ?? detectAgentState(agent, screen);
}
