import { type Assignee, type IssueState } from "@hivemind/core";

const STATES: IssueState[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
];

export function parseState(s: string): IssueState | null {
  // Accept hyphenated and underscored synonyms.
  const norm = s.toLowerCase().replace(/-/g, "_");
  return (STATES as string[]).includes(norm) ? (norm as IssueState) : null;
}

const KNOWN_AGENTS = new Set([
  "claude",
  "codex",
  "gemini",
  "opencode",
  "openclaw",
  "hermes",
  "amp",
  "cursor",
]);

/**
 * Heuristic: if the id matches a known agent CLI, assignee.type = agent.
 * Otherwise member. Override with --assignee-type explicitly.
 */
export function parseAssignee(
  id: string | undefined,
  typeOverride?: "agent" | "member",
  model?: string
): Assignee | null {
  if (!id) return null;
  const lower = id.toLowerCase();
  const type = typeOverride ?? (KNOWN_AGENTS.has(lower) ? "agent" : "member");
  const a: Assignee = { type, id: lower };
  if (model) a.model = model;
  return a;
}

/** Strip leading @ from any reference: "@PAY-118" → "PAY-118". */
export function stripAt(s: string): string {
  return s.startsWith("@") ? s.slice(1) : s;
}

/** Extract all @ID mentions from a text blob (returns deduped, in-order). */
export function extractMentions(text: string): string[] {
  const re = /@([A-Z][A-Z0-9]{1,9}-\d+(?:\.\d+)*)/g;
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const id = m[1];
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** Coerce string "true"/"false"/"1"/"0" or actual bool to boolean. */
export function asBool(v: unknown): boolean | undefined {
  if (v == null) return undefined;
  if (typeof v === "boolean") return v;
  const s = String(v).toLowerCase();
  if (s === "true" || s === "1" || s === "yes") return true;
  if (s === "false" || s === "0" || s === "no") return false;
  return undefined;
}

/** Coerce string to int or undefined. */
export function asInt(v: unknown): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined;
  return n;
}

/** citty passes a repeated flag value as `string[]` when set multiple times,
 *  or a bare string when set once. Normalize to an array. */
export function collectMulti(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map(String);
  return [String(v)];
}
