/**
 * Review comments on a diff, stored in `.hivemind/review.json`.
 *
 * They used to live in renderer localStorage, where nothing outside that one
 * window could read them: not the CLI, not an agent, not another machine. An
 * agent that cannot list a comment cannot resolve one, so the store moves here
 * and the review loop becomes something a plugin command can serve.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findRoot } from "./storage.js";

export type ReviewSide = "deletions" | "additions";

export interface ReviewReply {
  author: string;
  body: string;
  at: string;
}

export interface ReviewComment {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  side: ReviewSide;
  body: string;
  author: string;
  at: string;
  resolved?: boolean;
  /** Set when resolved, if whoever resolved it said why. */
  summary?: string;
  replies?: ReviewReply[];
}

export const REVIEW_FILE = "review.json";

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
    const file = str(c.file, 4096);
    const body = str(c.body);
    if (!id || !file || !body) continue;
    const start = line(c.startLine);
    const end = Math.max(start, line(c.endLine));
    out.push({
      id,
      file,
      startLine: start,
      endLine: end,
      side: c.side === "deletions" ? "deletions" : "additions",
      body,
      author: str(c.author, 200) ?? "unknown",
      at: str(c.at, 40) ?? new Date().toISOString(),
      ...(c.resolved === true ? { resolved: true } : {}),
      ...(str(c.summary) ? { summary: str(c.summary)! } : {}),
      ...(Array.isArray(c.replies)
        ? { replies: c.replies.map(reply).filter((r): r is ReviewReply => r !== null) }
        : {}),
    });
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

export async function addComment(
  root: string,
  input: Omit<ReviewComment, "id" | "at"> & { id?: string; at?: string },
): Promise<ReviewComment> {
  const list = await readComments(root);
  const comment = normalizeComments([
    { ...input, id: input.id ?? `c-${Date.now().toString(36)}-${list.length.toString(36)}`, at: input.at ?? new Date().toISOString() },
  ])[0];
  if (!comment) throw new Error("a review comment needs a file and a body");
  list.push(comment);
  await writeComments(root, list);
  return comment;
}

export function replyTo(root: string, id: string, r: ReviewReply): Promise<ReviewComment | null> {
  return mutate(root, id, (c) => ({ ...c, replies: [...(c.replies ?? []), r] }));
}

export function resolveComment(root: string, id: string, summary?: string): Promise<ReviewComment | null> {
  return mutate(root, id, (c) => ({ ...c, resolved: true, ...(summary ? { summary } : {}) }));
}

export function reopenComment(root: string, id: string): Promise<ReviewComment | null> {
  return mutate(root, id, ({ resolved: _r, summary: _s, ...rest }) => rest);
}

export interface CommentFilter {
  file?: string;
  status?: "open" | "resolved" | "all";
}

export async function listComments(root: string, filter: CommentFilter = {}): Promise<ReviewComment[]> {
  const status = filter.status ?? "open";
  return (await readComments(root)).filter(
    (c) =>
      (filter.file === undefined || c.file === filter.file) &&
      (status === "all" || (status === "resolved") === (c.resolved === true)),
  );
}
