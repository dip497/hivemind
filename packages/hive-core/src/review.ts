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
import { findRoot, HiveError, replaceFile, replaceFileWithCopy } from "./storage.js";

export * from "./review-shape.js";
import { byAgent, onPage, REVIEW_INTENTS, statusOf, type DiffComment, type PageAnchor, type PageBox, type PageComment, type PageElement, type ReviewComment, type ReviewIntent, type ReviewReply, type CommentFields } from "./review-shape.js";

export const REVIEW_FILE = "review.json";
/** Where a page note's picture is kept, beside review.json. */
export const PICTURES_DIR = "pages";
/** What a note may keep as proof. */
export const ATTACHMENT_KINDS = ["webm", "mp4", "png", "jpg", "gif"] as const;
export const MAX_ATTACHMENT_BYTES = 200 * 1024 * 1024;

// A file a note keeps is named in pages/, never by a path.
const isPictureName = (v: unknown): v is string => typeof v === "string" && /^[\w.-]{1,120}\.png$/.test(v) && !v.startsWith(".");
const attachmentName = new RegExp(`^[\\w-]{1,120}\\.(${ATTACHMENT_KINDS.join("|")})$`);
const isAttachmentName = (v: unknown): v is string => typeof v === "string" && attachmentName.test(v);

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
  const picture = isPictureName(a.picture) ? a.picture : null;
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
    if (page) {
      const attachments = Array.isArray(c.attachments) ? c.attachments.filter(isAttachmentName).slice(0, 50) : [];
      out.push({ ...fields, page, ...(attachments.length ? { attachments } : {}) });
      continue;
    }
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
  await fs.mkdir(path.dirname(file), { recursive: true });
  await replaceFile(file, `${JSON.stringify(list, null, 2)}\n`);
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
  const gone = list.find((c) => c.id === id);
  if (!gone) return false;
  await writeComments(root, list.filter((c) => c !== gone));
  if (onPage(gone)) await removePageFiles(root, [...(gone.page.picture ? [gone.page.picture] : []), ...(gone.attachments ?? [])]);
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

/** Done, saying how, with any `proof` (paths of files to keep on it). */
export function resolveComment(root: string, id: string, summary?: string, proof: readonly string[] = []): Promise<ReviewComment | null> {
  return withAttachments(root, id, proof, ({ seen: _s, ...c }) => {
    open(c, "reopen it first");
    return { ...c, resolved: true, ...(summary ? { summary } : {}) };
  });
}

/** Keep `proof` (paths of files) on a note, however it stands. */
export function attachToComment(root: string, id: string, proof: readonly string[]): Promise<ReviewComment | null> {
  return withAttachments(root, id, proof, (c) => c);
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

/** The folder a note's files go in, made if it is missing; one that is a link is refused. */
async function picturesFolder(root: string): Promise<string> {
  const dir = path.join(root, PICTURES_DIR);
  await fs.mkdir(dir, { recursive: true });
  if (!(await fs.lstat(dir)).isDirectory()) throw new HiveError("REVIEW_PICTURES", `${dir} is not a folder`);
  // A picture can show a signed-in page: `git add -A` must not take it into the project's history.
  await replaceFile(path.join(dir, ".gitignore"), "*\n");
  return dir;
}

const fileStem = (id: string): string => id.replace(/[^\w-]/g, "");

/** Keep a page note's picture beside review.json; the name to store on its anchor. */
export async function writePicture(root: string, id: string, png: Uint8Array): Promise<string> {
  const name = `${fileStem(id)}.png`;
  await replaceFile(path.join(await picturesFolder(root), name), png);
  return name;
}

export const picturePath = (root: string, name: string): string => path.join(root, PICTURES_DIR, name);

const kindOf = (file: string): string => path.extname(file).slice(1).toLowerCase();

/** Refused, saying why, when `file` cannot be kept as proof on a note. */
export async function checkAttachment(file: string): Promise<void> {
  if (!(ATTACHMENT_KINDS as readonly string[]).includes(kindOf(file))) {
    throw new HiveError("ATTACHMENT_TYPE", `${file}: a note keeps only ${ATTACHMENT_KINDS.map((k) => `.${k}`).join(", ")} files`);
  }
  const found = await fs.stat(file).catch(() => null);
  if (!found?.isFile()) throw new HiveError("ATTACHMENT_MISSING", `${file} is not a file`);
  if (found.size > MAX_ATTACHMENT_BYTES) throw new HiveError("ATTACHMENT_TOO_BIG", `${file} is ${Math.ceil(found.size / 1024 / 1024)} MB: a note keeps at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB per file`);
}

/** Copy `proof` in beside the note and make `change`, with the copies named on it. A change
 *  refused, or a copy that fails, leaves nothing behind. */
async function withAttachments(root: string, id: string, proof: readonly string[], change: (c: ReviewComment) => ReviewComment): Promise<ReviewComment | null> {
  if (!proof.length) return mutate(root, id, change);
  for (const file of proof) await checkAttachment(file);
  const found = (await readComments(root)).find((c) => c.id === id);
  if (!found) return null;
  if (!onPage(found)) throw new HiveError("ATTACHMENT_NOT_A_NOTE", `comment ${id} is on a diff: only a note on a page keeps attachments`);
  const dir = await picturesFolder(root);
  const taken = found.attachments?.length ?? 0;
  const names = proof.map((file, i) => `${fileStem(id)}-${taken + i + 1}.${kindOf(file)}`);
  try {
    for (const [i, file] of proof.entries()) await replaceFileWithCopy(path.join(dir, names[i]!), file);
    return await mutate(root, id, (c) => {
      const next = change(c);
      return onPage(next) ? { ...next, attachments: [...(next.attachments ?? []), ...names] } : next;
    });
  } catch (e) {
    await removePageFiles(root, names);
    throw e;
  }
}

/** Remove a note's files. Through a pictures folder that is a link, nothing. */
async function removePageFiles(root: string, names: readonly string[]): Promise<void> {
  const dir = path.join(root, PICTURES_DIR);
  if (!names.length || !(await fs.lstat(dir).then((d) => d.isDirectory(), () => false))) return;
  await Promise.all(names.map((name) => fs.rm(path.join(dir, name), { force: true }).catch(() => {})));
}

/** Where a note's file `name` is, to show it. None for a name no note could hold, for what is not
 *  there, or for a link a cloned project committed in place of the folder or the file. */
export async function pageFilePath(root: string, name: string): Promise<string | null> {
  if (!isPictureName(name) && !isAttachmentName(name)) return null;
  const dir = path.join(root, PICTURES_DIR);
  const file = path.join(dir, name);
  const real = await Promise.all([fs.lstat(dir), fs.lstat(file)]).then(([d, f]) => d.isDirectory() && f.isFile(), () => false);
  return real ? file : null;
}

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
    ...(c.attachments ?? []).map((name) => `  attachment: ${picturePath(root, name)}`),
    ...(byAgent(c) ? [`  left by an agent: ${c.author}`] : []),
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
    "Mark each with `hive ctl notes seen <id>` when you start on it, then `hive ctl notes done <id> --summary \"…\"` or `hive ctl notes dismiss <id> --reason \"…\"`; answer a question with `hive ctl notes reply <id> \"…\"`.",
  ].join("\n");
}
