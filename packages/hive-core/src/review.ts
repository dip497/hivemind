/**
 * Review comments, on a diff's lines or on a page in a Browser tile, stored in
 * `.hivemind/review.json`.
 *
 * They used to live in renderer localStorage, where nothing outside that one
 * window could read them: not the CLI, not an agent, not another machine. An
 * agent that cannot list a comment cannot resolve one, so the store moves here
 * and the review loop becomes something a plugin command can serve.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findRoot, HiveError } from "./storage.js";

export * from "./review-shape.js";
import { onPage, REVIEW_INTENTS, statusOf, type DiffComment, type PageAnchor, type PageBox, type PageComment, type PageElement, type ReviewComment, type ReviewIntent, type ReviewReply, type CommentFields } from "./review-shape.js";

export const REVIEW_FILE = "review.json";
/** Where a page note's picture is kept, beside review.json. */
export const PICTURES_DIR = "pages";

export function reviewPath(root: string): string {
  return path.join(root, REVIEW_FILE);
}

/** Where a repository's comments live.
 *
 *  A `.hivemind/` workspace keeps them with the code. A plain git repo gets
 *  them in the config dir instead: the diff tile works without `hive init`,
 *  and leaving a comment must not quietly turn a repo into a workspace. */
export async function reviewRoot(repoPath: string, homeDir: string = os.homedir()): Promise<string> {
  const root = await findRoot(repoPath, homeDir);
  if (root) return root;
  const base = process.env.XDG_CONFIG_HOME?.trim() || path.join(homeDir, ".config");
  return path.join(base, "hivemind", "review", repoPath.replace(/[^a-zA-Z0-9]+/g, "_").slice(-120));
}

const str = (v: unknown, max = 10_000): string | null =>
  typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
const line = (v: unknown): number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 10_000_000 ? v : 0;
const coord = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.max(-1e7, Math.min(1e7, Math.round(v))) : 0);

function box(raw: unknown): PageBox | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  return { x: coord(b.x), y: coord(b.y), width: Math.max(0, coord(b.width)), height: Math.max(0, coord(b.height)) };
}

function element(raw: unknown): PageElement | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const name = str(e.name, 300);
  const selector = str(e.selector, 2000);
  const b = box(e.box);
  if (!name || !selector || !b) return null;
  return { name, selector, ...(str(e.text, 500) ? { text: str(e.text, 500)! } : {}), ...(str(e.nearby, 500) ? { nearby: str(e.nearby, 500)! } : {}), box: b };
}

function anchor(raw: unknown): PageAnchor | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const url = str(a.url, 8192);
  const elements = Array.isArray(a.elements) ? a.elements.slice(0, 50).map(element).filter((e): e is PageElement => e !== null) : [];
  const area = a.area === undefined ? null : box(a.area);
  if (!url || (!elements.length && !area)) return null;
  const v = (a.viewport ?? {}) as Record<string, unknown>;
  // A picture is a file name in pages/, never a path.
  const picture = typeof a.picture === "string" && /^[\w.-]{1,120}\.png$/.test(a.picture) && !a.picture.startsWith(".") ? a.picture : null;
  return {
    url,
    ...(str(a.title, 300) ? { title: str(a.title, 300)! } : {}),
    viewport: { width: Math.max(0, coord(v.width)), height: Math.max(0, coord(v.height)) },
    elements,
    ...(area ? { area } : {}),
    ...(picture ? { picture } : {}),
  };
}

function reply(raw: unknown): ReviewReply | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const body = str(r.body);
  if (!body) return null;
  return { author: str(r.author, 200) ?? "unknown", body, at: str(r.at, 40) ?? new Date().toISOString() };
}

/** Accept whatever is on disk (hand-edited, half-written, older shape). */
export function normalizeComments(raw: unknown): ReviewComment[] {
  if (!Array.isArray(raw)) return [];
  const out: ReviewComment[] = [];
  for (const item of raw.slice(0, 5000)) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    const id = str(c.id, 200);
    const body = str(c.body);
    if (!id || !body) continue;
    const fields: CommentFields = {
      id,
      body,
      author: str(c.author, 200) ?? "unknown",
      at: str(c.at, 40) ?? new Date().toISOString(),
      ...(REVIEW_INTENTS.includes(c.intent as ReviewIntent) ? { intent: c.intent as ReviewIntent } : {}),
      ...(c.resolved === true ? { resolved: true } : {}),
      ...(c.resolved === true && c.dismissed === true ? { dismissed: true } : {}),
      ...(c.resolved !== true && c.seen === true ? { seen: true } : {}),
      ...(str(c.summary) ? { summary: str(c.summary)! } : {}),
      ...(Array.isArray(c.replies)
        ? { replies: c.replies.map(reply).filter((r): r is ReviewReply => r !== null) }
        : {}),
    };
    const page = c.page === undefined ? null : anchor(c.page);
    if (page) { out.push({ ...fields, page }); continue; }
    const file = str(c.file, 4096);
    if (!file) continue;
    const start = line(c.startLine);
    out.push({ ...fields, file, startLine: start, endLine: Math.max(start, line(c.endLine)), side: c.side === "deletions" ? "deletions" : "additions" });
  }
  return out;
}

export async function readComments(root: string): Promise<ReviewComment[]> {
  try {
    return normalizeComments(JSON.parse(await fs.readFile(reviewPath(root), "utf8")));
  } catch {
    return [];
  }
}

export async function writeComments(root: string, list: readonly ReviewComment[]): Promise<void> {
  const file = reviewPath(root);
  const tmp = `${file}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(tmp, `${JSON.stringify(list, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
}

/** Read → change → write. The whole file is one document, so callers never
 *  race a partial list past each other. */
async function mutate(
  root: string,
  id: string,
  change: (c: ReviewComment) => ReviewComment,
): Promise<ReviewComment | null> {
  const list = await readComments(root);
  const i = list.findIndex((c) => c.id === id);
  if (i === -1) return null;
  const next = change(list[i]!);
  list[i] = next;
  await writeComments(root, list);
  return next;
}

type NewComment = (Omit<DiffComment, "id" | "at"> | Omit<PageComment, "id" | "at">) & { id?: string; at?: string };

export async function addComment(root: string, input: NewComment): Promise<ReviewComment> {
  const list = await readComments(root);
  const comment = normalizeComments([
    { ...input, id: input.id ?? `c-${Date.now().toString(36)}-${list.length.toString(36)}`, at: input.at ?? new Date().toISOString() },
  ])[0];
  if (!comment) throw new Error("a review comment needs a body, and a file or a place on a page");
  list.push(comment);
  await writeComments(root, list);
  return comment;
}

/** Refused: the comment is not where the change can start from. */
const refuse = (c: ReviewComment, what: string): never => {
  throw new HiveError("REVIEW_STATE", `comment ${c.id} is ${statusOf(c)}: ${what}`);
};
const open = (c: ReviewComment, what: string) => { if (c.resolved) refuse(c, what); };

export function editComment(root: string, id: string, body: string): Promise<ReviewComment | null> {
  return mutate(root, id, (c) => ({ ...c, body }));
}

export async function deleteComment(root: string, id: string): Promise<boolean> {
  const list = await readComments(root);
  const next = list.filter((c) => c.id !== id);
  if (next.length === list.length) return false;
  await writeComments(root, next);
  return true;
}

export function replyTo(root: string, id: string, r: ReviewReply): Promise<ReviewComment | null> {
  return mutate(root, id, (c) => ({ ...c, replies: [...(c.replies ?? []), r] }));
}

/** An agent has read it and is on it. */
export function markSeen(root: string, id: string): Promise<ReviewComment | null> {
  return mutate(root, id, (c) => {
    open(c, "only an open comment can be marked seen");
    return { ...c, seen: true };
  });
}

export function resolveComment(root: string, id: string, summary?: string): Promise<ReviewComment | null> {
  return mutate(root, id, ({ seen: _s, ...c }) => {
    open(c, "reopen it first");
    return { ...c, resolved: true, ...(summary ? { summary } : {}) };
  });
}

/** Closed without doing it, saying why. */
export async function dismissComment(root: string, id: string, reason: string): Promise<ReviewComment | null> {
  if (!reason.trim()) throw new HiveError("REVIEW_REASON", "dismissing a comment needs a reason");
  return mutate(root, id, ({ seen: _s, ...c }) => {
    open(c, "reopen it first");
    return { ...c, resolved: true, dismissed: true, summary: reason.trim() };
  });
}

export function reopenComment(root: string, id: string): Promise<ReviewComment | null> {
  return mutate(root, id, (c) => {
    if (!c.resolved) refuse(c, "only a resolved or dismissed comment can be reopened");
    const { resolved: _r, dismissed: _d, summary: _s, seen: _n, ...rest } = c;
    return rest;
  });
}

export interface CommentFilter {
  file?: string;
  /** open includes seen; resolved includes dismissed. */
  status?: "open" | "resolved" | "all";
  on?: "diff" | "page";
}

export async function listComments(root: string, filter: CommentFilter = {}): Promise<ReviewComment[]> {
  const status = filter.status ?? "open";
  return (await readComments(root)).filter(
    (c) =>
      (filter.file === undefined || (!onPage(c) && c.file === filter.file)) &&
      (filter.on === undefined || (filter.on === "page") === onPage(c)) &&
      (status === "all" || (status === "resolved") === (c.resolved === true)),
  );
}

/** Keep a page note's picture beside review.json; the name to store on its anchor. */
export async function writePicture(root: string, id: string, png: Uint8Array): Promise<string> {
  const name = `${id.replace(/[^\w-]/g, "")}.png`;
  await fs.mkdir(path.join(root, PICTURES_DIR), { recursive: true });
  await fs.writeFile(path.join(root, PICTURES_DIR, name), png);
  return name;
}

export const picturePath = (root: string, name: string): string => path.join(root, PICTURES_DIR, name);

const boxText = (b: PageBox): string => `${b.width}×${b.height} at ${b.x},${b.y}`;

/** A page note as an agent reads it: the page, what it points at, its picture, and the words. */
export function pageNoteText(c: PageComment, root: string): string {
  const p = c.page;
  return [
    `${c.id}${c.intent ? ` (${c.intent})` : ""}: ${c.body}`,
    `  page: ${p.url}${p.title ? ` "${p.title}"` : ""}, seen at ${p.viewport.width}×${p.viewport.height}`,
    ...(p.area ? [`  area: ${boxText(p.area)}`] : []),
    ...p.elements.map((e) => `  - ${e.name}: \`${e.selector}\`, ${boxText(e.box)}${e.text ? `, text "${e.text}"` : ""}${e.nearby ? `, near "${e.nearby}"` : ""}`),
    ...(p.picture ? [`  picture: ${picturePath(root, p.picture)}`] : []),
    ...(c.replies ?? []).map((r) => `  ↳ ${r.author}: ${r.body}`),
  ].join("\n");
}

/** Open page notes as one message to an agent, with how to answer them. */
export function pageNotesMessage(notes: readonly PageComment[], root: string): string {
  const n = notes.length;
  return [
    `${n} note${n === 1 ? "" : "s"} on a page to address:`,
    "",
    ...notes.flatMap((c) => [pageNoteText(c, root), ""]),
    "Mark each with `hive review seen <id>` when you start on it, then `hive review resolve <id> --summary \"…\"` or `hive review dismiss <id> --reason \"…\"`; answer a question with `hive review reply <id> \"…\"`.",
  ].join("\n");
}
