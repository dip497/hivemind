/** Output formatters — both plain-text (for humans) and JSON (for scripts). */
import type { Issue, IssueSummary } from "@hivemind/core";
import { printFailure } from "./exit-codes.js";

export interface OutCtx {
  json: boolean;
}

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  orange: "\x1b[38;5;208m",
};

const isTTY = process.stdout.isTTY;
const c = (color: string, s: string) => (isTTY ? `${color}${s}${C.reset}` : s);

export const stateColor = {
  backlog: C.dim,
  todo: C.cyan,
  in_progress: C.green,
  in_review: C.orange,
  done: C.green,
  cancelled: C.dim,
} as const;

/** A success: with --json, the result as one JSON object on one line (a list goes under a name,
 *  so every result is an object); else `render`'s text. */
export function ok<T extends object | string>(ctx: OutCtx, data: T extends readonly unknown[] ? never : T, render?: () => string): void {
  if (ctx.json) console.log(JSON.stringify(data));
  else if (render) console.log(render());
  else console.log(typeof data === "string" ? data : JSON.stringify(data, null, 2));
}

/** A failure, printed and exited with as exit-codes.ts says: its code in capitals, its exit code
 *  from the table unless `exit` is given. */
export function err(ctx: OutCtx, code: string, message: string, exit?: number, fix?: string): never {
  return printFailure(ctx.json, { code: code.toUpperCase(), message, ...(fix ? { fix } : {}) }, exit);
}

/** One line per issue; an issue that names its status (a workspace with its own workflow) shows
 *  that, coloured by its state. */
export function renderIssueList(items: Array<IssueSummary & { statusName?: string }>): string {
  if (items.length === 0) return c(C.dim, "no issues");
  const idW = Math.max(...items.map((i) => i.id.length));
  const shown = (i: IssueSummary & { statusName?: string }) => i.statusName ?? i.state;
  const stateW = Math.max(...items.map((i) => shown(i).length));
  return items
    .map((i) => {
      const id = c(C.bold, i.id.padEnd(idW));
      const state = c(stateColor[i.state], shown(i).padEnd(stateW));
      const labels = i.labels.length > 0 ? c(C.dim, ` [${i.labels.join(",")}]`) : "";
      const a = i.assignee ? c(C.cyan, ` @${i.assignee.id}`) : "";
      const gh = i.github ? c(C.dim, ` gh#${i.github}`) : "";
      const parent = i.parent ? c(C.dim, ` ↳${i.parent}`) : "";
      return `${id}  ${state}  ${i.title}${labels}${a}${gh}${parent}`;
    })
    .join("\n");
}

export function renderIssue(i: Issue): string {
  const lines: string[] = [];
  lines.push(`${c(C.bold, i.id)}  ${c(stateColor[i.state], i.state)}  ${i.title}`);
  const meta: string[] = [];
  if (i.status && i.status !== i.state) meta.push(`status: ${i.status}`);
  if (i.parent) meta.push(`parent: ${i.parent}`);
  if (i.labels.length > 0) meta.push(`labels: ${i.labels.join(", ")}`);
  if (i.assignee) meta.push(`assignee: @${i.assignee.id} (${i.assignee.type})`);
  if (i.github) meta.push(`gh: #${i.github}`);
  meta.push(`created: ${i.created.slice(0, 16).replace("T", " ")}`);
  meta.push(`updated: ${i.updated.slice(0, 16).replace("T", " ")}`);
  lines.push(c(C.dim, meta.join("  ·  ")));
  lines.push("");
  if (i.sections.description) {
    lines.push(c(C.bold, "Description"));
    lines.push(i.sections.description);
    lines.push("");
  }
  if (i.sections.acceptanceCriteria.length > 0) {
    lines.push(c(C.bold, "Acceptance criteria"));
    for (const a of i.sections.acceptanceCriteria) {
      lines.push(`  ${a.done ? c(C.green, "✓") : "○"}  ${a.text}`);
    }
    lines.push("");
  }
  if (i.sections.activity.length > 0) {
    lines.push(c(C.bold, "Activity"));
    for (const e of i.sections.activity) {
      lines.push(`  ${c(C.dim, e.at)}  ${c(C.cyan, "@" + e.who)}  ${e.message}`);
    }
  }
  return lines.join("\n");
}
