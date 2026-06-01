/**
 * Multi-agent terminal-state detection by screen scraping — ported from herdr
 * (github.com/ogulcancelik/herdr `src/detect.rs`, AGPL-3.0). herdr is a Rust
 * agent multiplexer; its per-agent output heuristics are battle-tested across
 * 15 CLI agents. We feed xterm's rendered viewport instead of a terminal tail
 * snapshot and return hivemind's UI status buckets.
 *
 * Claude keeps its own richer detector (./claude-state.ts) which distinguishes
 * permission vs. question; every other agent collapses both into "blocked".
 */
import { detectClaudeState, type ClaudeState } from "./claude-state";

export type Agent =
  | "pi"
  | "claude"
  | "codex"
  | "gemini"
  | "cursor"
  | "antigravity"
  | "cline"
  | "opencode"
  | "copilot"
  | "kimi"
  | "kiro"
  | "droid"
  | "amp"
  | "grok"
  | "hermes";

/** herdr's three-state model. "blocked" = needs the human (approval/question). */
export type AgentState = "idle" | "working" | "blocked";

/** UI status buckets hivemind tiles render. Claude gets permission/question. */
export type TileStatus = "working" | "idle" | "blocked" | "permission" | "question";

const ALIASES: Record<string, Agent> = {
  pi: "pi",
  claude: "claude",
  "claude-code": "claude",
  codex: "codex",
  gemini: "gemini",
  cursor: "cursor",
  "cursor-agent": "cursor",
  agy: "antigravity",
  antigravity: "antigravity",
  "antigravity-cli": "antigravity",
  cline: "cline",
  opencode: "opencode",
  "open-code": "opencode",
  copilot: "copilot",
  "github-copilot": "copilot",
  ghcs: "copilot",
  kimi: "kimi",
  kiro: "kiro",
  "kiro-cli": "kiro",
  droid: "droid",
  amp: "amp",
  "amp-local": "amp",
  grok: "grok",
  "grok-build": "grok",
  hermes: "hermes",
  "hermes-agent": "hermes",
};

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

// --- shared helpers (ported from detect.rs) -------------------------------

const BRAILLE = /[⠀-⣿]/;

function hasBrailleSpinner(content: string): boolean {
  return content.split("\n").some((line) => BRAILLE.test(line.trim().charAt(0)));
}

/** "do you want" / "would you like" followed by "yes" or "❯". */
function hasConfirmationPrompt(lower: string): boolean {
  const pos = (() => {
    const a = lower.indexOf("do you want");
    if (a !== -1) return a;
    return lower.indexOf("would you like");
  })();
  if (pos === -1) return false;
  const after = lower.slice(pos);
  return after.includes("yes") || after.includes("❯");
}

function hasInterruptPattern(lower: string): boolean {
  return (
    lower.includes("esc to interrupt") ||
    lower.includes("ctrl+c to interrupt") ||
    (lower.includes("esc") && lower.includes("interrupt"))
  );
}

function cursorWordActive(rest: string): boolean {
  const word = rest.trim().split(/\s+/)[0] ?? "";
  return word.replace(/[^a-z]+$/i, "").toLowerCase().endsWith("ing");
}

// --- per-agent detectors --------------------------------------------------

function detectPi(content: string): AgentState {
  return content.includes("Working...") ? "working" : "idle";
}

function detectCodex(content: string): AgentState {
  const lower = content.toLowerCase();
  if (
    lower.includes("press enter to confirm or esc to cancel") ||
    lower.includes("enter to submit answer") ||
    lower.includes("allow command?") ||
    lower.includes("[y/n]") ||
    lower.includes("yes (y)") ||
    hasConfirmationPrompt(lower)
  )
    return "blocked";
  if (hasInterruptPattern(lower)) return "working";
  if (content.split("\n").some((l) => l.trimStart().startsWith("•") && l.includes("Working (")))
    return "working";
  return "idle";
}

function detectGemini(content: string): AgentState {
  const lower = content.toLowerCase();
  if (lower.includes("waiting for user confirmation")) return "blocked";
  if (
    content.includes("│ Apply this change") ||
    content.includes("│ Allow execution") ||
    content.includes("│ Do you want to proceed") ||
    hasConfirmationPrompt(lower)
  )
    return "blocked";
  if (lower.includes("esc to cancel")) return "working";
  return "idle";
}

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

function detectOpencode(content: string): AgentState {
  const lower = content.toLowerCase();
  const questionPrompt =
    lower.includes("esc dismiss") &&
    (lower.includes("enter confirm") || lower.includes("enter submit") || lower.includes("enter toggle")) &&
    (content.includes("↑↓ select") || content.includes("⇆ tab"));
  if (content.includes("△ Permission required") || questionPrompt) return "blocked";
  if (hasInterruptPattern(lower)) return "working";
  return "idle";
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

function detectKiro(content: string): AgentState {
  const lower = content.toLowerCase();
  const toolSpinner = content.split("\n").some((line) => {
    const trimmed = line.trimStart();
    const first = trimmed.charAt(0);
    if (!"◔◑◕●".includes(first)) return false;
    return /[a-z]/i.test(trimmed.slice(1).trimStart().charAt(0));
  });
  if (lower.includes("kiro is working") || (lower.includes("esc to cancel") && toolSpinner))
    return "working";
  return "idle";
}

function detectDroid(content: string): AgentState {
  const lower = content.toLowerCase();
  const hasExecute = content.includes("EXECUTE");
  const chrome =
    lower.includes("enter to select") ||
    lower.includes("↑↓ to navigate") ||
    lower.includes("esc to cancel");
  const options = lower.includes("> yes, allow") || lower.includes("> no, cancel");
  if (hasExecute && (chrome || options)) return "blocked";
  if (chrome && options) return "blocked";
  if (hasBrailleSpinner(content) && lower.includes("esc to stop")) return "working";
  if (lower.includes("esc to stop")) return "working";
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

const DETECTORS: Record<Exclude<Agent, "claude">, (c: string) => AgentState> = {
  pi: detectPi,
  codex: detectCodex,
  gemini: detectGemini,
  cursor: detectCursor,
  antigravity: detectAntigravity,
  cline: detectCline,
  opencode: detectOpencode,
  copilot: detectCopilot,
  kimi: detectKimi,
  kiro: detectKiro,
  droid: detectDroid,
  amp: detectAmp,
  grok: detectGrok,
  hermes: detectHermes,
};

/** herdr three-state detection for a known non-claude agent. */
export function detectAgentState(agent: Exclude<Agent, "claude">, screen: string): AgentState {
  return DETECTORS[agent](screen);
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
 * One call → the UI status bucket for any agent. Claude uses its richer
 * detector (permission/question); the rest map blocked → "blocked".
 */
export function detectTileStatus(agent: Agent, screen: string): TileStatus {
  if (agent === "claude") {
    const s: ClaudeState = detectClaudeState(screen);
    return s; // "permission" | "question" | "working" | "idle" are all TileStatus
  }
  return detectAgentState(agent, screen);
}
