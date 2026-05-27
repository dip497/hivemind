/** Output formatters — both plain-text (for humans) and JSON (for scripts). */
import type { CliResult, Issue, IssueSummary } from "@hivemind/core";

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

export function ok<T>(ctx: OutCtx, data: T, render?: () => string): void {
  if (ctx.json) {
    const result: CliResult<T> = { ok: true, data };
    console.log(JSON.stringify(result, null, 2));
  } else if (render) {
    console.log(render());
  } else {
    console.log(typeof data === "string" ? data : JSON.stringify(data, null, 2));
  }
}

export function err(ctx: OutCtx, code: string, message: string): never {
  if (ctx.json) {
    const result: CliResult<never> = { ok: false, error: message, code };
    console.log(JSON.stringify(result, null, 2));
  } else {
    process.stderr.write(`${c(C.red, "error")} ${c(C.dim, `[${code}]`)} ${message}\n`);
  }
  process.exit(1);
}

export function renderIssueList(items: IssueSummary[]): string {
  if (items.length === 0) return c(C.dim, "no issues");
  const idW = Math.max(...items.map((i) => i.id.length));
  const stateW = Math.max(...items.map((i) => i.state.length));
  return items
    .map((i) => {
      const id = c(C.bold, i.id.padEnd(idW));
      const state = c(stateColor[i.state], i.state.padEnd(stateW));
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
