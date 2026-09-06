/**
 * Pure helpers behind `hive ctl` — argument shaping and the read/poll schedule.
 * No I/O, so they're unit-tested directly (tests/ctl-args.test.ts).
 */

/** Split a `||`-separated list (workflow items / stages). */
export function splitDouble(s: string | undefined): string[] | undefined {
  if (s == null) return undefined;
  const parts = String(s).split("||").map((x) => x.trim()).filter(Boolean);
  return parts.length ? parts : undefined;
}

/** Comma-separated key tokens for `ctl keys`: "Down,Enter" → ["Down","Enter"]. */
export function parseKeys(s: string): string[] {
  return String(s).split(",").map((x) => x.trim()).filter(Boolean);
}

/** Positive integer from a flag, else `dflt`; throws USAGE on garbage. */
export function intFlag(v: unknown, name: string, dflt: number): number {
  if (v == null || v === "") return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new UsageError(`--${name} must be a non-negative number (got ${String(v)})`);
  return Math.floor(n);
}

export class UsageError extends Error {
  code = "USAGE";
  constructor(message: string) { super(message); this.name = "UsageError"; }
}

/** Boolean flag that may arrive as true/false/"true"/"false"/undefined. */
export function boolFlag(v: unknown): boolean | undefined {
  if (v == null) return undefined;
  if (typeof v === "boolean") return v;
  const s = String(v).toLowerCase();
  if (s === "true" || s === "1" || s === "yes") return true;
  if (s === "false" || s === "0" || s === "no") return false;
  return undefined;
}

/** Cap on ONE HCP request inside a `read` loop. Well under Claude Code's
 *  120 s Bash-tool default and any proxy idle timeout: the total wait is the
 *  sum of many of these, never one long request. */
export const READ_SLICE_MS = 10_000;

/** The sequence of per-request `timeoutMs` values a `read --timeout <total>`
 *  issues: slices of READ_SLICE_MS, the last one shortened to fit. `--poll` is
 *  a single zero-length slice (return immediately with the current state). */
export function readSchedule(totalMs: number, sliceMs = READ_SLICE_MS): number[] {
  if (totalMs <= 0) return [0];
  const out: number[] = [];
  let left = totalMs;
  while (left > 0) { const s = Math.min(sliceMs, left); out.push(s); left -= s; }
  return out;
}

export interface WorkflowFlags {
  shape?: string; items?: string; prompt?: string; stages?: string; input?: string;
  "reduce-prompt"?: string; agent?: string; model?: string; frame?: string; supervise?: string;
  "max-concurrent"?: string | number; timeout?: string | number; close?: boolean;
}

/** `ctl workflow` flags → the `workflow.run` params + the wire ceiling. The
 *  ceiling sits ABOVE the worst-case server-side run (workers are concurrent,
 *  so per-turn × units is a safe over-estimate), capped at 24 h. */
export function workflowParams(f: WorkflowFlags, callerTile?: string): { params: Record<string, unknown>; ceilingMs: number } {
  const shape = f.shape ?? "fanout";
  if (!["fanout", "pipeline", "mapreduce"].includes(shape)) throw new UsageError(`--shape must be fanout | pipeline | mapreduce (got ${shape})`);
  const items = splitDouble(f.items);
  const stages = splitDouble(f.stages);
  if (shape === "pipeline" && !stages) throw new UsageError("pipeline needs --stages 'a || b || c'");
  if (shape !== "pipeline" && !items) throw new UsageError(`${shape} needs --items 'x || y' and --prompt`);
  if (shape !== "pipeline" && !f.prompt) throw new UsageError(`${shape} needs --prompt (use {item})`);
  if (shape === "mapreduce" && !f["reduce-prompt"]) throw new UsageError("mapreduce needs --reduce-prompt (use {results})");
  const perTurn = intFlag(f.timeout, "timeout", 600_000);
  const params: Record<string, unknown> = {
    shape, items, prompt: f.prompt, stages, input: f.input, reduce_prompt: f["reduce-prompt"],
    agent: f.agent ?? "claude", model: f.model, frame: f.frame, supervise: f.supervise,
    max_concurrent: f["max-concurrent"] != null ? intFlag(f["max-concurrent"], "max-concurrent", 6) : undefined,
    timeout_ms: f.timeout != null ? perTurn : undefined,
    close_when_done: f.close || undefined,
    callerTile,
  };
  const units = (items?.length ?? 0) + (stages?.length ?? 0) + 2;
  const ceilingMs = Math.min(24 * 60 * 60 * 1000, perTurn * units + 30_000);
  return { params, ceilingMs };
}

/** Last `n` lines of a text (used for `stream --lines` when the server has no
 *  replay support and the client must trim a replayed chunk itself). */
export function tailLines(text: string, n: number): string {
  if (n <= 0 || !text) return "";
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n).join("\n") + (text.endsWith("\n") ? "\n" : "");
}
