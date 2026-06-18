/**
 * Plan markdown ↔ blocks, and the annotation → feedback formatter. Pure (no
 * React, no DOM) so it's unit-testable and shared by the tile + tests.
 *
 * `exportAnnotations` is the hivemind equivalent of plannotator's
 * `exportAnnotations` + `wrapFeedbackForAgent`: it turns the user's marks into a
 * structured markdown brief that becomes the deny `permissionDecisionReason` —
 * i.e. exactly what the agent reads to revise its plan.
 */
import { marked, type Token } from "marked";
import type { Annotation, PlanBlock } from "./types";

/** Split plan markdown into top-level blocks. Uses marked's lexer (AST), NOT the
 *  HTML path — we keep each block's raw source so the tile can re-render it and
 *  anchor annotations to a stable id. `space` tokens (blank lines) are dropped. */
export function parsePlanToBlocks(md: string): PlanBlock[] {
  let tokens: Token[];
  try {
    tokens = marked.lexer(md);
  } catch {
    // Lexer should never throw on text, but never let a parse error blank the
    // review — fall back to one paragraph block holding the whole plan.
    return [{ id: "b0", type: "paragraph", raw: md, text: md }];
  }
  const out: PlanBlock[] = [];
  let i = 0;
  for (const t of tokens) {
    if (t.type === "space") continue;
    const raw = (t as { raw?: string }).raw ?? "";
    if (!raw.trim()) continue;
    out.push({ id: `b${i++}`, type: t.type, raw, text: tokenText(t).trim() });
  }
  // Degenerate input (empty / whitespace) → a single block so the UI still renders.
  if (out.length === 0) out.push({ id: "b0", type: "paragraph", raw: md, text: md.trim() });
  return out;
}

/** Best-effort plain text of a token (for selection fallback + deletion quoting). */
function tokenText(t: Token): string {
  const anyT = t as { text?: string; raw?: string };
  if (typeof anyT.text === "string") return anyT.text;
  return anyT.raw ?? "";
}

/** True when there is something to send back (any annotation present). */
export function hasFeedback(annotations: Annotation[]): boolean {
  return annotations.length > 0;
}

const fence = (s: string): string => {
  // Pick a fence longer than any backtick run inside, so code with ``` survives.
  const longest = (s.match(/`+/g) ?? []).reduce((n, m) => Math.max(n, m.length), 0);
  return "`".repeat(Math.max(3, longest + 1));
};

/** Format the marks into the structured feedback the agent receives on "request
 *  changes". Deterministic ordering: deletions, then per-block comments (in plan
 *  order), then global comments — each numbered. */
export function exportAnnotations(blocks: PlanBlock[], annotations: Annotation[]): string {
  if (annotations.length === 0) return "Changes requested.";

  const order = new Map(blocks.map((b, i) => [b.id, i]));
  const byKind = (k: Annotation["kind"]) => annotations.filter((a) => a.kind === k);
  const inPlanOrder = (a: Annotation, b: Annotation) =>
    (order.get(a.blockId ?? "") ?? 1e9) - (order.get(b.blockId ?? "") ?? 1e9) || a.createdAt - b.createdAt;

  const sections: string[] = [];
  let n = 0;

  for (const a of byKind("deletion").sort(inPlanOrder)) {
    n++;
    const f = fence(a.originalText);
    sections.push(
      `## ${n}. Remove this\n${f}\n${a.originalText}\n${f}\n> Drop this from the plan.`,
    );
  }

  for (const a of byKind("comment").sort(inPlanOrder)) {
    n++;
    const head = a.quickLabel
      ? `## ${n}. [${a.quickLabel}] On: "${oneLine(a.originalText)}"`
      : `## ${n}. Feedback on: "${oneLine(a.originalText)}"`;
    const body = a.comment?.trim() ? `\n> ${a.comment.trim().replace(/\n/g, "\n> ")}` : "";
    sections.push(head + body);
  }

  for (const a of byKind("global").sort((x, y) => x.createdAt - y.createdAt)) {
    n++;
    const label = a.quickLabel ? `[${a.quickLabel}] ` : "";
    const body = a.comment?.trim() ? `\n> ${label}${a.comment.trim().replace(/\n/g, "\n> ")}` : `\n> ${label}`;
    sections.push(`## ${n}. General feedback about the plan${body}`);
  }

  const summary = `${n} piece${n === 1 ? "" : "s"} of feedback on the plan. Please revise and present an updated plan.`;
  return `# Plan feedback\n\n${summary}\n\n${sections.join("\n\n")}`;
}

/** Collapse a selection to a single quotable line (trim + squash newlines), and
 *  cap it so a whole-block selection doesn't dump a wall of text into the head. */
function oneLine(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? flat.slice(0, 157) + "…" : flat;
}
