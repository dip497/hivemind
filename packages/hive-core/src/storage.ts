/**
 * Filesystem layer for `.hivemind/`.
 *
 * Layout:
 *   .hivemind/
 *   ├── config.yaml
 *   ├── issues/
 *   │   ├── PAY-118.md
 *   │   ├── PAY-122.md
 *   │   └── PAY-122/        <- sub-issue directory (children of PAY-122)
 *   │       ├── PAY-122.1.md
 *   │       └── PAY-122.2.md
 *   └── .agent.md            <- auto-generated context for AI agents
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import YAML from "yaml";
import {
  ConfigZ,
  IssueFrontmatterZ,
  type AcceptanceItem,
  type ActivityEntry,
  type Config,
  type Issue,
  type IssueSections,
  type IssueSummary,
} from "./types.js";

const DIR = ".hivemind";

/** Find the nearest `.hivemind/` directory walking up from `cwd`. */
export async function findRoot(cwd: string = process.cwd()): Promise<string | null> {
  let dir = path.resolve(cwd);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = path.join(dir, DIR);
    try {
      const st = await fs.stat(candidate);
      if (st.isDirectory()) return candidate;
    } catch {
      /* not here */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function requireRoot(cwd?: string): Promise<string> {
  const r = await findRoot(cwd);
  if (!r) {
    throw new HiveError(
      "no_root",
      "no .hivemind/ found in this directory or any parent. run `hive init` first."
    );
  }
  return r;
}

export class HiveError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "HiveError";
  }
}

// ── config ────────────────────────────────────────────────────────

// In-process read coalescer: every IPC handler on first launch hits
// `readConfig` in parallel. When the file is broken, naive code lets each
// caller race into `writeConfig` — even with idempotent repair the file
// can be half-truncated if two writes interleave. Cache the IN-FLIGHT
// promise per root so callers share the same repair pass.
const readConfigInFlight = new Map<string, Promise<Config>>();

export async function readConfig(root: string): Promise<Config> {
  const existing = readConfigInFlight.get(root);
  if (existing) return existing;
  const promise = (async () => {
    const p = path.join(root, "config.yaml");
    let raw = "";
    try {
      raw = await fs.readFile(p, "utf8");
    } catch {
      /* missing file → treat as empty, self-heal below */
    }
    const parsed = (raw ? YAML.parse(raw) : {}) ?? {};
    const result = ConfigZ.safeParse(parsed);
    if (result.success) return result.data;

    // Self-heal: an early hive init wrote configs without `prefix`, and users
    // sometimes hand-edit the file and drop fields. Refusing to read the
    // config hard-blocks every IPC handler (createIssue, listIssues, …) and
    // surfaces as a raw stack trace in the UI. Instead, fill in defaults
    // and write the repaired config back so the next read is clean.
    const obj = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>;
    const repaired: Config = {
      prefix: deriveDefaultPrefix(typeof obj.prefix === "string" ? obj.prefix : undefined, root),
      next_id:
        typeof obj.next_id === "number" && Number.isInteger(obj.next_id) && obj.next_id > 0
          ? obj.next_id
          : 1,
      agents:
        obj.agents && typeof obj.agents === "object" && !Array.isArray(obj.agents)
          ? (obj.agents as Config["agents"])
          : {},
    };
    const final = ConfigZ.safeParse(repaired);
    if (!final.success) {
      throw new HiveError(
        "bad_config",
        `.hivemind/config.yaml invalid and self-repair failed: ${final.error.message}`
      );
    }
    await writeConfig(root, final.data);
    return final.data;
  })();
  readConfigInFlight.set(root, promise);
  try {
    return await promise;
  } finally {
    readConfigInFlight.delete(root);
  }
}

/** Sanitize a candidate string into a valid Config.prefix, or derive one
 *  from the workspace folder name when no candidate is usable. Always
 *  returns something that matches ConfigZ's prefix regex. */
function deriveDefaultPrefix(candidate: string | undefined, root: string): string {
  const tryClean = (s: string): string | null => {
    const cleaned = s.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (cleaned.length >= 2 && /^[A-Z]/.test(cleaned)) return cleaned.slice(0, 10);
    return null;
  };
  if (candidate) {
    const c = tryClean(candidate);
    if (c) return c;
  }
  // root is `<repo>/.hivemind` — use the repo dir name.
  const repoDir = path.basename(path.dirname(root));
  const fromDir = tryClean(repoDir);
  if (fromDir) return fromDir;
  // Last resort: a stable fallback that satisfies the schema.
  return "HIV";
}

export async function writeConfig(root: string, cfg: Config): Promise<void> {
  const p = path.join(root, "config.yaml");
  // Validate before writing.
  const parsed = ConfigZ.parse(cfg);
  // Atomic write: write to a sibling temp + rename. Bare `fs.writeFile` can
  // produce a half-truncated file if two processes interleave (or a crash
  // hits mid-write). rename is atomic on the same filesystem.
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, YAML.stringify(parsed), "utf8");
  await fs.rename(tmp, p);
}

// Per-root async mutex serializing the next_id read-modify-write. Without it,
// two concurrent allocations (CLI `new` + MCP `hive_create_issue`, or two MCP
// calls) both read the same next_id and mint the SAME issue id, then one write
// silently clobbers the other. The readConfig coalescer makes this WORSE — it
// hands both racers the identical in-memory config object — so collisions are
// reliable, not occasional. This chain guarantees each allocation's full
// read→increment→write completes before the next begins.
const allocChains = new Map<string, Promise<unknown>>();

/** Reserve and increment the next ID atomically (serialized read-modify-write). */
export async function allocateId(root: string): Promise<{ id: string; cfg: Config }> {
  const prev = allocChains.get(root) ?? Promise.resolve();
  const run = prev.then(async () => {
    const cfg = await readConfig(root);
    const id = `${cfg.prefix}-${cfg.next_id}`;
    cfg.next_id += 1;
    await writeConfig(root, cfg);
    return { id, cfg };
  });
  // Keep the chain alive even if THIS allocation rejects, so one failure doesn't
  // wedge every later allocation for the root.
  allocChains.set(root, run.then(() => undefined, () => undefined));
  return run;
}

// ── issues: paths ──────────────────────────────────────────────────

/**
 * Resolve the on-disk path for an issue id. Sub-issues live in directories
 * named after their parent: e.g. PAY-122/PAY-122.1.md.
 *
 * - "PAY-118"    → .hivemind/issues/PAY-118.md
 * - "PAY-122.1"  → .hivemind/issues/PAY-122/PAY-122.1.md
 * - "PAY-1.2.3"  → .hivemind/issues/PAY-1/PAY-1.2/PAY-1.2.3.md
 */
// Issue id format: prefix (one uppercase letter + 1-9 uppercase/digit chars) +
// "-" + decimal number, optionally followed by dotted sub-decimals. Validates
// every callsite (CLI + IPC) so a malicious id like "../../etc/passwd" can't
// escape `.hivemind/issues/` and the resulting `fs.unlink`/`fs.writeFile` /
// `fs.readFile` is bounded. (Defense-in-depth — IPC validates separately.)
const ISSUE_ID_RE = /^[A-Z][A-Z0-9]{1,9}-\d+(\.\d+)*$/;
export function assertValidIssueId(id: string): void {
  if (!ISSUE_ID_RE.test(id)) {
    throw new HiveError("invalid_arg", `invalid issue id: ${id}`);
  }
}
export function issuePath(root: string, id: string): string {
  assertValidIssueId(id);
  const parts = id.split(".");
  const dir = path.join(root, "issues");
  if (parts.length === 1) {
    return path.join(dir, `${id}.md`);
  }
  const segs: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) {
    segs.push(parts.slice(0, i + 1).join("."));
  }
  return path.join(dir, ...segs, `${id}.md`);
}

/** Read an issue file by id (throws HiveError if missing). */
export async function readIssue(root: string, id: string): Promise<Issue> {
  const p = issuePath(root, id);
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf8");
  } catch {
    throw new HiveError("not_found", `issue ${id} not found`);
  }
  return parseIssueFile(p, raw);
}

export function parseIssueFile(p: string, raw: string): Issue {
  const parsed = matter(raw);
  const fmResult = IssueFrontmatterZ.safeParse(parsed.data);
  if (!fmResult.success) {
    throw new HiveError("bad_issue", `${p}: invalid frontmatter: ${fmResult.error.message}`);
  }
  const sections = parseSections(parsed.content);
  return {
    ...fmResult.data,
    path: p,
    sections,
    raw: parsed.content,
  };
}

/** Serialize an Issue back to a markdown file string. */
export function serializeIssue(issue: Issue): string {
  const fm = IssueFrontmatterZ.parse({
    id: issue.id,
    title: issue.title,
    state: issue.state,
    parent: issue.parent,
    labels: issue.labels,
    assignee: issue.assignee,
    github: issue.github,
    links: issue.links,
    created: issue.created,
    updated: issue.updated,
  }) as Record<string, unknown>;
  // Omit `links` entirely when empty/absent so issues without cross-repo links
  // don't grow a noisy `links: []` line across the whole vault on first save.
  if (!Array.isArray(fm.links) || fm.links.length === 0) delete fm.links;
  const body = serializeSections(issue.sections);
  return matter.stringify(body, fm);
}

export async function writeIssue(issue: Issue): Promise<void> {
  await fs.mkdir(path.dirname(issue.path), { recursive: true });
  await fs.writeFile(issue.path, serializeIssue(issue), "utf8");
}

export async function deleteIssueFile(root: string, id: string): Promise<void> {
  const p = issuePath(root, id);
  try {
    await fs.unlink(p);
  } catch {
    throw new HiveError("not_found", `issue ${id} not found`);
  }
  // Clean up empty parent dirs (best-effort, ignore errors).
  let dir = path.dirname(p);
  const issuesRoot = path.join(root, "issues");
  while (dir.startsWith(issuesRoot) && dir !== issuesRoot) {
    try {
      const entries = await fs.readdir(dir);
      if (entries.length > 0) break;
      await fs.rmdir(dir);
    } catch {
      break;
    }
    dir = path.dirname(dir);
  }
}

// ── issues: list / summary ────────────────────────────────────────

/**
 * Walk .hivemind/issues/ and return frontmatter-only summaries. Faster than
 * full parse; used by `list` and by chokidar-fed UI queries.
 */
export async function listIssues(root: string): Promise<IssueSummary[]> {
  const issuesDir = path.join(root, "issues");
  const files = await walk(issuesDir, ".md");
  const out: IssueSummary[] = [];
  for (const p of files) {
    try {
      const raw = await fs.readFile(p, "utf8");
      const parsed = matter(raw);
      const fm = IssueFrontmatterZ.safeParse(parsed.data);
      if (!fm.success) continue; // skip invalid files in list view
      const d = fm.data;
      out.push({
        id: d.id,
        title: d.title,
        state: d.state,
        parent: d.parent,
        labels: d.labels,
        assignee: d.assignee,
        github: d.github,
        created: d.created,
        updated: d.updated,
        path: p,
      });
    } catch {
      /* skip unreadable files */
    }
  }
  // Stable ID-major-first sort.
  out.sort((a, b) => compareIds(a.id, b.id));
  return out;
}

function compareIds(a: string, b: string): number {
  const ap = a.split(/[-.]/).map((s, i) => (i === 0 ? s : Number(s)));
  const bp = b.split(/[-.]/).map((s, i) => (i === 0 ? s : Number(s)));
  const len = Math.max(ap.length, bp.length);
  for (let i = 0; i < len; i++) {
    const av = ap[i] ?? 0;
    const bv = bp[i] ?? 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

async function walk(dir: string, ext: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true })) as import("node:fs").Dirent[];
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walk(p, ext)));
    } else if (e.isFile() && e.name.endsWith(ext)) {
      out.push(p);
    }
  }
  return out;
}

// ── markdown body parsing ──────────────────────────────────────────

// Accept any heading level (# … ######) so users can write `# Description`
// without breaking parse. Serializer always emits `##`, so the file
// normalises after one round-trip.
const SEC_DESC = /^#{1,6}\s+Description\s*$/im;
// Accept a real markdown heading (`## Acceptance criteria`) OR a plain/bold
// label line (`Acceptance criteria:` / `**Acceptance criteria:**`). Agents
// (via hive_create_issue, which only had a free-text `description`) routinely
// embed the checklist under a plain `Acceptance criteria:` line inside the
// description — those items then never reached the dedicated section and the
// board showed an empty Acceptance Criteria panel. Matching the label line
// splits them out; serializeSections rewrites it canonically on next save.
const SEC_AC = /^\s*(?:#{1,6}\s+|\*\*\s*)?Acceptance\s+criteria\s*:?\s*\**\s*$/im;
const SEC_ACT = /^#{1,6}\s+Activity\s*$/im;

/** Split the body into our three known sections + extra. Tolerant: missing sections become empty. */
export function parseSections(body: string): IssueSections {
  const sections: IssueSections = {
    description: "",
    acceptanceCriteria: [],
    activity: [],
    extra: "",
  };

  // Find offsets of known headings.
  const heads: Array<{ name: "desc" | "ac" | "act"; idx: number; end: number }> = [];
  const push = (name: "desc" | "ac" | "act", re: RegExp) => {
    const m = re.exec(body);
    if (m && m.index !== undefined) {
      heads.push({ name, idx: m.index, end: m.index + m[0].length });
    }
  };
  push("desc", SEC_DESC);
  push("ac", SEC_AC);
  push("act", SEC_ACT);
  heads.sort((a, b) => a.idx - b.idx);

  if (heads.length === 0) {
    sections.description = body.trim();
    return sections;
  }

  // Slice each section.
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i]!;
    const next = heads[i + 1];
    const sliceEnd = next ? next.idx : body.length;
    const text = body.slice(h.end, sliceEnd).trim();
    if (h.name === "desc") sections.description = text;
    else if (h.name === "ac") sections.acceptanceCriteria = parseAcceptance(text);
    else if (h.name === "act") sections.activity = parseActivity(text);
  }

  // Text BEFORE the first known heading is also description.
  if (heads[0]!.idx > 0) {
    const pre = body.slice(0, heads[0]!.idx).trim();
    if (pre && !sections.description) sections.description = pre;
    else if (pre) sections.description = `${pre}\n\n${sections.description}`;
  }
  return sections;
}

const TODO_RE = /^- \[( |x|X)\]\s+(.*)$/;
function parseAcceptance(text: string): AcceptanceItem[] {
  const items: AcceptanceItem[] = [];
  for (const line of text.split("\n")) {
    const m = TODO_RE.exec(line.trim());
    if (m) items.push({ done: m[1]!.toLowerCase() === "x", text: m[2]!.trim() });
  }
  return items;
}

// Activity line: either the new ISO form (`2026-05-27T09:55:00.000Z`, single
// non-whitespace token) OR the legacy 2-token form (`2026-05-27 09:55`). The
// timestamp is the first capture, who is the second, message the rest.
const ACT_RE = /^-\s+(\S+(?:\s\S+)?)\s+·\s+(\S+)\s+·\s+(.+)$/;
function parseActivity(text: string): ActivityEntry[] {
  const out: ActivityEntry[] = [];
  for (const line of text.split("\n")) {
    const m = ACT_RE.exec(line.trim());
    if (m) {
      const raw = m[1]!;
      // Preserve the on-disk form so serializeSections can round-trip without
      // rewriting every legacy `YYYY-MM-DD HH:MM` row to ISO on the next
      // update (would create huge noisy diffs across the workspace).
      out.push({ at: normalizeActivityTs(raw), rawAt: raw, who: m[2]!, message: m[3]! });
    }
  }
  return out;
}

/** Convert legacy `YYYY-MM-DD HH:MM` (UTC, stored without Z) into a full ISO
 *  with Z so renderers parse it as UTC, not local. ISO inputs pass through. */
function normalizeActivityTs(raw: string): string {
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) return raw; // already ISO
  const m = /^(\d{4}-\d{2}-\d{2})\s(\d{2}:\d{2})$/.exec(raw);
  if (m) return `${m[1]}T${m[2]}:00.000Z`;
  return raw;
}

export function serializeSections(s: IssueSections): string {
  const parts: string[] = [];
  if (s.description) parts.push(`## Description\n\n${s.description.trim()}`);
  if (s.acceptanceCriteria.length > 0) {
    const lines = s.acceptanceCriteria.map((a) => `- [${a.done ? "x" : " "}] ${a.text}`);
    parts.push(`## Acceptance criteria\n\n${lines.join("\n")}`);
  }
  if (s.activity.length > 0) {
    // Prefer `rawAt` (preserved from disk) so loaded-then-rewritten issues
    // keep their legacy timestamp form. New entries (no rawAt) emit ISO-Z.
    const lines = s.activity.map((e) => `- ${e.rawAt ?? e.at} · ${e.who} · ${e.message}`);
    parts.push(`## Activity\n\n${lines.join("\n")}`);
  }
  if (s.extra.trim()) parts.push(s.extra.trim());
  return parts.join("\n\n") + "\n";
}

/** Append an activity line. Mutates the issue and returns it.
 *
 * `at` is stored as a full ISO-8601 timestamp WITH the `Z` (UTC) suffix.
 * Older versions stored a truncated `YYYY-MM-DD HH:MM` form, which JS
 * `new Date(str)` parses as local time — that misrendered every activity
 * row by the user's TZ offset (e.g. IST +5:30 showed every entry as "5h
 * ago" the moment it was written). Full ISO removes the ambiguity. The
 * parser accepts the legacy format for backward compatibility (existing
 * notes on disk keep loading).
 */
export function appendActivity(issue: Issue, who: string, message: string, at?: Date): Issue {
  const ts = (at ?? new Date()).toISOString();
  issue.sections.activity.push({ at: ts, who, message });
  issue.updated = new Date().toISOString();
  return issue;
}

// ── high-level issue helpers (used by IPC + CLI) ─────────────────────

import { SAMPLE_ISSUE_BODY } from "./templates.js";

export interface CreateIssueOpts {
  title: string;
  state?: IssueSummary["state"];
  parent?: string;
  labels?: string[];
  assignee?: Issue["assignee"];
  description?: string;
  /** Structured acceptance criteria. Without this, agents cram the checklist
   *  into `description` as raw `- [ ]` lines and the dedicated panel is empty. */
  acceptanceCriteria?: AcceptanceItem[];
  /** Linked GitHub issue/PR number. */
  github?: number | null;
  /** Actor recorded in the creation activity entry. Default "ui". */
  who?: string;
}

/**
 * Allocate a fresh top-level id (or next sub-issue id under `parent`),
 * build a new Issue object with a sane default body, and write it to disk.
 * Returns the freshly written Issue.
 */
export async function createIssue(root: string, opts: CreateIssueOpts): Promise<Issue> {
  let finalId: string;
  if (opts.parent) {
    finalId = await nextSubIssueId(root, opts.parent);
  } else {
    const { id } = await allocateId(root);
    finalId = id;
  }
  const now = new Date().toISOString();
  const issue: Issue = {
    id: finalId,
    title: opts.title.trim() || "(untitled)",
    state: opts.state ?? "todo",
    parent: opts.parent ?? null,
    labels: opts.labels ?? [],
    assignee: opts.assignee ?? null,
    github: opts.github ?? null,
    created: now,
    updated: now,
    path: issuePath(root, finalId),
    sections: {
      description: (opts.description ?? "").trim(),
      acceptanceCriteria: opts.acceptanceCriteria ?? [],
      activity: [
        {
          at: now,
          who: opts.who ?? "ui",
          message: opts.parent ? `created as sub-issue of ${opts.parent}` : "created",
        },
      ],
      extra: "",
    },
    raw: SAMPLE_ISSUE_BODY,
  };
  await writeIssue(issue);
  return issue;
}

/** Find the next available `.N` suffix under an existing parent issue. */
async function nextSubIssueId(root: string, parentId: string): Promise<string> {
  // Sub-issue files live in .hivemind/issues/<parent-segs>/<parentId>.N.md
  const parentDir = path.dirname(issuePath(root, `${parentId}.0`));
  let highest = 0;
  try {
    const entries = await fs.readdir(parentDir);
    for (const e of entries) {
      const m = e.match(new RegExp(`^${parentId.replace(/\./g, "\\.")}\\.(\\d+)\\.md$`));
      if (m) {
        const n = parseInt(m[1]!, 10);
        if (n > highest) highest = n;
      }
    }
  } catch {
    /* parent dir doesn't exist yet → start at 1 */
  }
  return `${parentId}.${highest + 1}`;
}

export type IssuePatch = Partial<{
  title: string;
  state: IssueSummary["state"];
  parent: string | undefined;
  labels: string[];
  assignee: Issue["assignee"];
  github: number | null;
  description: string;
  acceptanceCriteria: Issue["sections"]["acceptanceCriteria"];
  extra: string;
}>;

/**
 * Read-merge-write update. Patches frontmatter and/or sections, appends an
 * activity entry summarizing the diff, and writes back.
 */
export async function updateIssue(
  root: string,
  id: string,
  patch: IssuePatch,
  who: string = "ui",
  /** Optional free-text note appended to Activity in the SAME write — avoids a
   *  second read-modify-write (which could race with a concurrent op). */
  note?: string,
): Promise<Issue> {
  const issue = await readIssue(root, id);
  const summary: string[] = [];

  if (patch.title !== undefined && patch.title !== issue.title) {
    summary.push(`title: "${issue.title}" → "${patch.title}"`);
    issue.title = patch.title;
  }
  if (patch.state !== undefined && patch.state !== issue.state) {
    summary.push(`state: ${issue.state} → ${patch.state}`);
    issue.state = patch.state;
  }
  if (patch.parent !== undefined && patch.parent !== issue.parent) {
    summary.push(`parent: ${issue.parent ?? "—"} → ${patch.parent ?? "—"}`);
    issue.parent = patch.parent;
  }
  if (patch.labels !== undefined) {
    if (JSON.stringify(patch.labels) !== JSON.stringify(issue.labels)) {
      summary.push(`labels: [${issue.labels.join(",")}] → [${patch.labels.join(",")}]`);
      issue.labels = patch.labels;
    }
  }
  if (patch.assignee !== undefined) {
    const before = issue.assignee ? `@${issue.assignee.id}` : "—";
    const after = patch.assignee ? `@${patch.assignee.id}` : "—";
    if (before !== after) {
      summary.push(`assignee: ${before} → ${after}`);
      issue.assignee = patch.assignee;
    }
  }
  if (patch.github !== undefined && patch.github !== issue.github) {
    summary.push(`github: ${issue.github ?? "—"} → ${patch.github ?? "—"}`);
    issue.github = patch.github;
  }
  if (patch.description !== undefined) {
    issue.sections.description = patch.description;
  }
  if (patch.acceptanceCriteria !== undefined) {
    issue.sections.acceptanceCriteria = patch.acceptanceCriteria;
  }
  if (patch.extra !== undefined) {
    issue.sections.extra = patch.extra;
  }

  if (summary.length > 0) appendActivity(issue, who, summary.join(" · "));
  const trimmedNote = note?.trim();
  if (trimmedNote) appendActivity(issue, who, trimmedNote);
  issue.updated = new Date().toISOString();
  await writeIssue(issue);
  return issue;
}

/**
 * Append a free-form activity message (comment). Returns the updated issue.
 */
export async function commentOnIssue(
  root: string,
  id: string,
  message: string,
  who: string = "ui",
): Promise<Issue> {
  const issue = await readIssue(root, id);
  appendActivity(issue, who, message);
  await writeIssue(issue);
  return issue;
}

/**
 * Delete an issue file (and clean up empty parent dirs). Doesn't touch
 * sub-issues — caller must handle children explicitly.
 */
export async function deleteIssue(root: string, id: string): Promise<void> {
  await deleteIssueFile(root, id);
}
