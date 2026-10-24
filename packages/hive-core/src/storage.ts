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
import os from "node:os";
import matter from "gray-matter";
import YAML from "yaml";
import { z } from "zod";
import {
  ConfigZ,
  IssueFrontmatterZ,
  type AcceptanceItem,
  type ActivityEntry,
  type Config,
  type Issue,
  type IssuePatch,
  type IssueSections,
  type IssueSummary,
  type LayoutLine,
  type PrRef,
} from "./types.js";

const DIR = ".hivemind";

/** Find the nearest `.hivemind/` directory walking up from `cwd`.
 *
 * $HOME is a valid workspace when it IS the starting dir — so you can `hive
 * init` at home and it resolves for home itself. But a subfolder must NEVER
 * climb up and resolve to `~/.hivemind`: a stray `hive init` at $HOME would
 * otherwise hijack EVERY subfolder (the "only home gets selected" bug). The
 * `first` flag draws that line: inspect $HOME's own `.hivemind` only on the
 * initial iteration, and stop the moment we ASCEND into $HOME. `$HOME`'s parent
 * (e.g. `/home`) and the filesystem root never hold a usable workspace at all.
 */
export async function findRoot(
  cwd: string = process.cwd(),
  homeDir: string = os.homedir(),
): Promise<string | null> {
  let dir = path.resolve(cwd);
  const home = path.resolve(homeDir);
  const aboveHome = path.dirname(home);
  let first = true;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (dir === aboveHome || dir === "/") return null;
    // Reached $HOME by climbing from a subfolder → stop (no hijack). $HOME as
    // the explicit starting dir (first === true) still gets inspected below.
    if (dir === home && !first) return null;
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
    first = false;
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
    const { format: _format, ...rest } = obj; // keys this build doesn't name are kept
    const repaired: Config = {
      ...rest,
      prefix: deriveDefaultPrefix(typeof obj.prefix === "string" ? obj.prefix : undefined, root),
      next_id:
        typeof obj.next_id === "number" && Number.isInteger(obj.next_id) && obj.next_id > 0
          ? obj.next_id
          : 1,
      agents:
        obj.agents && typeof obj.agents === "object" && !Array.isArray(obj.agents)
          ? (obj.agents as Config["agents"])
          : {},
      ...(typeof obj.format === "number" && Number.isInteger(obj.format) && obj.format > 0 ? { format: obj.format } : {}),
    };
    const final = ConfigZ.safeParse(repaired);
    if (!final.success) {
      throw new HiveError(
        "bad_config",
        `.hivemind/config.yaml invalid and self-repair failed: ${z.prettifyError(final.error)}`
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
  await ensureWorkspaceCurrent(root);
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
// ── workspace format ──────────────────────────────────────────────

/** The on-disk format this build reads and writes. A workspace written at an earlier format is
 *  brought up to this one, step by step, the first time a process touches it; the step is
 *  recorded in config.yaml, so it runs once per workspace. */
export const WORKSPACE_FORMAT = 2;

const MIGRATIONS: ReadonlyArray<{ to: number; run: (root: string) => Promise<void> }> = [
  { to: 2, run: isoActivityTimestamps },
];

const current = new Map<string, Promise<void>>();

/** Bring the workspace to WORKSPACE_FORMAT if it is behind (once per process per root). */
export function ensureWorkspaceCurrent(root: string): Promise<void> {
  let p = current.get(root);
  if (!p) {
    p = migrateWorkspace(root).catch((e: unknown) => { current.delete(root); throw e; });
    current.set(root, p);
  }
  return p;
}

async function migrateWorkspace(root: string): Promise<void> {
  // Serialized with ID allocation: both rewrite config.yaml.
  const prev = allocChains.get(root) ?? Promise.resolve();
  const run = prev.then(async () => {
    let cfg: Config;
    try { cfg = await readConfig(root); } catch { return; } // not a workspace (yet)
    const from = cfg.format ?? 1;
    if (from > WORKSPACE_FORMAT) {
      throw new HiveError("newer_workspace", `${root} was written by a newer hivemind (format ${from}; this one reads ${WORKSPACE_FORMAT}) — update hivemind`);
    }
    for (const m of MIGRATIONS) {
      if (m.to <= from) continue;
      await m.run(root);
      await writeConfig(root, { ...(await readConfig(root)), format: m.to });
    }
  });
  allocChains.set(root, run.catch(() => {}));
  return run;
}

/** Format 2: activity rows carry a full ISO-8601 UTC timestamp. Format 1 wrote
 *  `YYYY-MM-DD HH:MM` (UTC, no zone), which readers took for local time. Only rows inside an
 *  issue's `## Activity` section are touched, and a file is written only if one changed. */
async function isoActivityTimestamps(root: string): Promise<void> {
  const OLD = /^(\s*-\s+)(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(\s+·\s)/;
  for (const file of await walk(path.join(root, "issues"), ".md")) {
    const raw = await fs.readFile(file, "utf8");
    let inActivity = false;
    let changed = false;
    const lines = raw.split("\n").map((line) => {
      if (/^##\s/.test(line)) inActivity = /^##\s+Activity\s*$/.test(line);
      if (!inActivity) return line;
      const m = OLD.exec(line);
      if (!m) return line;
      changed = true;
      return `${m[1]}${m[2]}T${m[3]}:00.000Z${m[4]}${line.slice(m[0].length)}`;
    });
    if (changed) await fs.writeFile(file, lines.join("\n"));
  }
}

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
  await ensureWorkspaceCurrent(root);
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf8");
  } catch {
    throw new HiveError("not_found", `issue ${id} not found`);
  }
  return parseIssueFile(p, raw);
}

/** Parse a file's frontmatter without the two gray-matter traps. `matter()` caches by content and
 *  hands every caller the same `data` object, so it is copied before anything (a loose schema keeps
 *  nested objects like `external` by reference) can mutate the cache in the long-running app. An
 *  unquoted ISO timestamp comes back as a `Date`, which `IsoZ` refuses — and `listIssues` would
 *  skip the file — so under the keys the schema times, a `Date` becomes its ISO string. A `Date`
 *  under a key we don't name stays a `Date`, and is written back as a YAML timestamp. */
function readFrontmatter(raw: string): { data: Record<string, unknown>; content: string } {
  const parsed = matter(raw);
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed.data)) data[k] = copyYaml(v, TIMED_KEYS.has(k));
  return { data, content: parsed.content };
}

const TIMED_KEYS = new Set(["created", "updated", "external", "pr"]);

/** A deep copy of parsed YAML (plain objects, arrays, scalars, `Date`). A hand copy rather than
 *  `structuredClone`, which made `listIssues` a quarter slower; it runs on every change in the app. */
function copyYaml(v: unknown, iso: boolean): unknown {
  if (v instanceof Date) return iso && !Number.isNaN(v.getTime()) ? v.toISOString() : new Date(v.getTime());
  if (Array.isArray(v)) return v.map((x) => copyYaml(x, iso));
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = copyYaml(x, iso);
    return o;
  }
  return v;
}

export function parseIssueFile(p: string, raw: string): Issue {
  const parsed = readFrontmatter(raw);
  const fmResult = IssueFrontmatterZ.safeParse(parsed.data);
  if (!fmResult.success) {
    throw new HiveError("bad_issue", `${p}: invalid frontmatter: ${z.prettifyError(fmResult.error)}`);
  }
  const sections = parseSections(parsed.content);
  return {
    ...fmResult.data,
    path: p,
    sections,
    raw: parsed.content,
  };
}

/** Frontmatter keys in the order they are written; keys this build doesn't name follow, as read. */
const FRONTMATTER_ORDER = [
  "id", "title", "state", "parent", "labels", "assignee", "github", "links", "created", "updated",
  "status", "external", "branch", "pr", "aliases",
] as const;

/** Serialize an Issue back to a markdown file string. */
export function serializeIssue(issue: Issue): string {
  const { path: _path, sections: _sections, raw: _raw, ...fields } = issue;
  const parsed = IssueFrontmatterZ.parse(fields) as Record<string, unknown>;
  const fm: Record<string, unknown> = {};
  for (const k of FRONTMATTER_ORDER) if (parsed[k] !== undefined) fm[k] = parsed[k];
  for (const [k, v] of Object.entries(parsed)) if (!(k in fm) && v !== undefined) fm[k] = v;
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
  await ensureWorkspaceCurrent(root);
  const issuesDir = path.join(root, "issues");
  const files = await walk(issuesDir, ".md");
  const out: IssueSummary[] = [];
  for (const p of files) {
    try {
      const raw = await fs.readFile(p, "utf8");
      const fm = IssueFrontmatterZ.safeParse(readFrontmatter(raw).data);
      if (!fm.success) continue; // skip invalid files in list view
      const d = fm.data;
      const summary: IssueSummary = {
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
      };
      // Only the ones the file has, so a summary is the same shape it always was without them.
      for (const k of ["links", "status", "external", "branch", "pr", "aliases"] as const) {
        if (d[k] !== undefined) Object.assign(summary, { [k]: d[k] });
      }
      out.push(summary);
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
// Only the real `## Acceptance criteria` heading. A plain or bold "Acceptance criteria" line is
// description text: Jira descriptions hold exactly that line over a plain bullet list (jira-fake
// OPS-7), and splitting it out dropped every line under it that wasn't a checkbox.
const SEC_AC = /^##[ \t]+Acceptance[ \t]+criteria[ \t]*$/im;
const SEC_ACT = /^#{1,6}\s+Activity\s*$/im;
/** A `#` or `##` heading inside Acceptance criteria or Activity starts a section we don't model. */
const OTHER_SECTION = /^#{1,2}[ \t]+\S/;

/** Split the body into our three known sections + extra. Tolerant: missing sections become empty.
 *  Lossless: what a section holds beyond its entries is kept in its layout or in `extra`, so
 *  `serializeSections` writes back what it read. */
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
    const slice = body.slice(h.end, sliceEnd);
    if (h.name === "desc") {
      sections.description = slice.trim();
    } else if (h.name === "ac") {
      const r = parseEntries(sectionLines(slice), parseTodo, "keep");
      sections.acceptanceCriteria = r.entries;
      if (r.layout) sections.acceptanceLayout = r.layout;
    } else {
      const r = parseEntries(sectionLines(slice), parseActivityRow, "cut");
      sections.activity = r.entries;
      if (r.layout) sections.activityLayout = r.layout;
      sections.extra = r.rest;
    }
  }

  // Text BEFORE the first known heading is also description.
  if (heads[0]!.idx > 0) {
    const pre = body.slice(0, heads[0]!.idx).trim();
    if (pre && !sections.description) sections.description = pre;
    else if (pre) sections.description = `${pre}\n\n${sections.description}`;
  }
  return sections;
}

/** A section's lines without the blank lines around them (an indented first line keeps its indent). */
function sectionLines(slice: string): string[] {
  const lines = slice.split("\n").map((l) => l.replace(/\r$/, ""));
  while (lines.length && !lines[0]!.trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  return lines;
}

/** Read a section's entries. `layout` is returned only when the section holds anything that a
 *  plain list of entries would not write back (a line that isn't an entry, an indented entry).
 *  From a `#`/`##` heading on, lines are not entries: `"keep"` keeps them in the layout (they sit
 *  before the next known section), `"cut"` returns them as `rest`. */
function parseEntries<T>(
  lines: string[],
  parse: (trimmed: string) => T | null,
  otherSection: "keep" | "cut",
): { entries: T[]; layout?: LayoutLine[]; rest: string } {
  const entries: T[] = [];
  const layout: LayoutLine[] = [];
  let plain = true;
  let inOther = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (OTHER_SECTION.test(line)) {
      if (otherSection === "cut") {
        while (layout.length && typeof layout[layout.length - 1] === "string" && !(layout[layout.length - 1] as string).trim()) layout.pop();
        return { entries, ...(plain ? {} : { layout }), rest: lines.slice(i).join("\n") };
      }
      inOther = true;
    }
    const entry = inOther ? null : parse(line.trim());
    if (entry) {
      const indent = line.slice(0, line.length - line.trimStart().length);
      entries.push(entry);
      layout.push({ indent });
      if (indent) plain = false;
    } else {
      layout.push(line);
      if (line.trim()) plain = false;
    }
  }
  return { entries, ...(plain ? {} : { layout }), rest: "" };
}

const TODO_RE = /^- \[( |x|X)\]\s+(.*)$/;
function parseTodo(line: string): AcceptanceItem | null {
  const m = TODO_RE.exec(line);
  return m ? { done: m[1]!.toLowerCase() === "x", text: m[2]!.trim() } : null;
}

// Activity row: `- <ISO-8601 timestamp> · <who> · <message>[ <!-- id:<row id> -->]`, one line.
// `who` may hold spaces (`Jane Doe (jira)`) but not ` · `. A message's line breaks are written as
// `<br>`, so a multi-line comment stays one row: an older build reads it as one longer line and
// writes it back unchanged, and markdown renders the break. The trailing comment is the row's
// stable id (a Jira comment's, say), invisible when rendered. Scanned by hand rather than with a
// regex, so a long line stays linear.
const ROW_ID_OPEN = "<!-- id:";
const ROW_ID_CLOSE = " -->";
function parseActivityRow(line: string): ActivityEntry | null {
  if (!line.startsWith("-") || !/\s/.test(line[1] ?? "")) return null;
  const sep1 = dotSeparator(line, 2);
  if (!sep1) return null;
  const sep2 = dotSeparator(line, sep1.end);
  if (!sep2) return null;
  const at = line.slice(2, sep1.start).trim();
  const who = line.slice(sep1.end, sep2.start).trim();
  let message = line.slice(sep2.end).trim();
  if (!at || /\s/.test(at) || !who || !message) return null;
  let id: string | undefined;
  const open = message.lastIndexOf(ROW_ID_OPEN);
  if (open >= 0 && message.endsWith(ROW_ID_CLOSE)) {
    const candidate = message.slice(open + ROW_ID_OPEN.length, message.length - ROW_ID_CLOSE.length);
    if (candidate && !/[\s<>]/.test(candidate)) {
      id = candidate;
      message = message.slice(0, open).trimEnd();
    }
  }
  message = message.split("<br>").join("\n");
  return id ? { at, who, message, id } : { at, who, message };
}

/** The next ` · ` (whitespace on both sides of the dot) at or after `from`. */
function dotSeparator(line: string, from: number): { start: number; end: number } | null {
  for (let i = line.indexOf("·", from); i >= 0; i = line.indexOf("·", i + 1)) {
    if (i > from && /\s/.test(line[i - 1]!) && /\s/.test(line[i + 1] ?? "")) {
      let end = i + 1;
      while (end < line.length && /\s/.test(line[end]!)) end++;
      return { start: i, end };
    }
  }
  return null;
}

function formatActivityRow(e: ActivityEntry): string {
  const who = e.who.replace(/\s+/g, " ");
  const message = e.message.replace(/\r?\n/g, "<br>");
  return `- ${e.at} · ${who} · ${message}${e.id ? ` ${ROW_ID_OPEN}${e.id}${ROW_ID_CLOSE}` : ""}`;
}

/** Write a section's entries into its layout: each slot takes the next entry (a slot left over
 *  when entries were removed is dropped), and entries beyond the slots go at the end of the
 *  section's own lines — before any unknown heading's block, which would swallow them. */
function writeEntries<T>(entries: T[], layout: LayoutLine[] | undefined, fmt: (e: T) => string): string[] {
  if (!layout) return entries.map(fmt);
  const out: string[] = [];
  let next = 0;
  let insertAt = -1;
  for (const l of layout) {
    if (typeof l === "string") {
      if (insertAt < 0 && OTHER_SECTION.test(l)) insertAt = out.length;
      out.push(l);
    } else if (next < entries.length) {
      out.push(l.indent + fmt(entries[next++]!));
    }
  }
  if (next < entries.length) {
    let at = insertAt < 0 ? out.length : insertAt;
    while (at > 0 && !out[at - 1]!.trim()) at--;
    out.splice(at, 0, ...entries.slice(next).map(fmt));
  }
  return out;
}

export function serializeSections(s: IssueSections): string {
  const parts: string[] = [];
  if (s.description) parts.push(`## Description\n\n${s.description.trim()}`);
  const ac = writeEntries(s.acceptanceCriteria, s.acceptanceLayout, (a) => `- [${a.done ? "x" : " "}] ${a.text}`);
  if (ac.some((l) => l.trim())) parts.push(`## Acceptance criteria\n\n${ac.join("\n")}`);
  const act = writeEntries(s.activity, s.activityLayout, formatActivityRow);
  if (act.some((l) => l.trim())) parts.push(`## Activity\n\n${act.join("\n")}`);
  if (s.extra.trim()) parts.push(s.extra.trim());
  return parts.join("\n\n") + "\n";
}

/** Append an activity line. Mutates the issue and returns it.
 *
 * `at` is stored as a full ISO-8601 timestamp WITH the `Z` (UTC) suffix, so every reader
 * parses it as UTC. `id` marks a row mirrored from elsewhere (see `ActivityEntry.id`).
 */
export function appendActivity(issue: Issue, who: string, message: string, at?: Date, id?: string): Issue {
  const ts = (at ?? new Date()).toISOString();
  issue.sections.activity.push(id ? { at: ts, who, message, id } : { at: ts, who, message });
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
  /** The git branch the work happens on. */
  branch?: string;
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
    ...(opts.branch ? { branch: opts.branch } : {}),
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
      const m = e.match(new RegExp(`^${parentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(\\d+)\\.md$`));
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

// IssuePatch now lives in types.ts (node-free single source — see there). Kept
// re-exported here so existing `@hivemind/core/storage` importers don't break.
export type { IssuePatch };

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
  if (patch.branch !== undefined && patch.branch !== (issue.branch ?? null)) {
    summary.push(`branch: ${issue.branch ?? "—"} → ${patch.branch ?? "—"}`);
    if (patch.branch === null) delete issue.branch;
    else issue.branch = patch.branch;
  }
  if (patch.pr !== undefined && JSON.stringify(patch.pr) !== JSON.stringify(issue.pr ?? null)) {
    const pr = (p: PrRef | null | undefined) => (p ? `${p.repo}#${p.number} (${p.state})` : "—");
    summary.push(`pr: ${pr(issue.pr)} → ${pr(patch.pr)}`);
    if (patch.pr === null) delete issue.pr;
    else issue.pr = patch.pr;
  }
  if (patch.aliases !== undefined && JSON.stringify(patch.aliases) !== JSON.stringify(issue.aliases ?? [])) {
    summary.push(`aliases: [${(issue.aliases ?? []).join(",")}] → [${patch.aliases.join(",")}]`);
    issue.aliases = patch.aliases;
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
