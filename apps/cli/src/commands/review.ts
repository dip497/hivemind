/**
 * `hive review` — the review comments a human left on a diff or a page, which an agent
 * has no other way to reach. Reads `.hivemind/review.json` directly, so it
 * works whether or not the app is running.
 *
 *   hive review list [--file <p>] [--status open|resolved|all] [--on page|board|diff|code] [--json]
 *   hive review show <id> [--json]
 *   hive review reply <id> <message> [--json]
 *   hive review resolve <id> [--summary <why>] [--attach <file>]... [--json]
 *   hive review seen <id> [--json]
 *   hive review dismiss <id> --reason <why> [--json]
 *   hive review reopen <id> [--json]
 *   hive review watch [--timeout <s>] [--json]     block until a new comment lands
 *
 * `hive ctl notes add` alone needs the running app, which holds the page.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { defineCommand } from "citty";
import {
  ATTACHMENT_KINDS, HiveError, MAX_ATTACHMENT_BYTES, attachToComment, boardNoteText, checkAttachment, codeCommentText, deleteComment, dismissComment, findCodeAnchor, findRoot, listComments, markSeen, onBoard, onCode, onPage,
  pageNoteText, readComments, replyTo, reopenComment, resolveComment, reviewRoot, statusOf, type PageBox, type ReviewComment,
} from "@hivemind/core";
import type { Result } from "@hivemind/workspace-api/methods";
import { err, ok } from "../format.js";
import { detectWho } from "../who.js";
import { HcpCliError, ownTile } from "../hcp.js";
import { openDrive } from "../drive.js";
import { helpFor } from "../exit-codes.js";

const run = promisify(execFile);

/** The same directory the app writes to: the workspace when there is one, the
 *  config dir keyed by repository when the diff tile is on a plain git repo. */
async function storeRoot(): Promise<string> {
  const cwd = process.cwd();
  const root = await findRoot(cwd);
  if (root) return root;
  return reviewRoot(await repoTop());
}

const repoTop = (): Promise<string> => run("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd() })
  .then((r) => r.stdout.trim())
  .catch(() => process.cwd());

/** A comment on code with where its lines are in the file now (`now`), null when they are gone. */
async function withNow(list: ReviewComment[]): Promise<ReviewComment[]> {
  if (!list.some(onCode)) return list;
  const top = await repoTop();
  const read = new Map<string, Promise<string[] | null>>();
  const linesOf = (file: string) => {
    if (!read.has(file)) read.set(file, fs.readFile(path.resolve(top, file), "utf8").then((t) => t.replace(/\r\n?/g, "\n").split("\n"), () => null));
    return read.get(file)!;
  };
  return Promise.all(list.map(async (c) => {
    if (!onCode(c)) return c;
    const lines = await linesOf(c.file);
    return { ...c, now: lines ? findCodeAnchor(lines, c) : null };
  }));
}

const nowOf = (c: ReviewComment): string => {
  if (!onCode(c) || !("now" in c)) return "";
  const now = (c as { now: { startLine: number; endLine: number } | null }).now;
  return now ? `now at ${c.file}:${now.startLine}${now.endLine !== now.startLine ? `-${now.endLine}` : ""}` : "outdated: its lines are no longer in the file";
};

const ATTACH_KINDS = ATTACHMENT_KINDS.map((k) => `.${k}`).join(", ");

/** What to do about a refusal, by its code. */
const FIX: Record<string, string> = {
  NOT_FOUND: "name a tile of this workspace: `hive ctl tiles` lists them",
  NO_BROWSER_TILE: "name a Browser tile with --tile <tile> (`hive ctl tiles`), or open one beside you: hive ctl open-tool @hivemind/web/browser --url <url>",
  SEVERAL_BROWSER_TILES: "name the one you mean with --tile <tile>",
  NO_ELEMENT: "check the selector against the page, or point at the place with --area x,y,width,height in page pixels",
  SEVERAL_ELEMENTS: "make the selector match one element, or point at the place with --area x,y,width,height in page pixels",
  ATTACHMENT_TYPE: `attach a video or image: ${ATTACH_KINDS}`,
  ATTACHMENT_TOO_BIG: `attach a shorter or smaller file, at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`,
  ATTACHMENT_MISSING: "give the path of a file on this computer",
  ATTACHMENT_NOT_A_NOTE: "attach files to a note on a page (`hive ctl notes list`)",
  REVIEW_PICTURES: "remove the link at .hivemind/pages: a note's files go in a real folder",
  UNAVAILABLE: "start the hivemind app",
  UNSUPPORTED: "run this with the hivemind app open: a note on a page needs the window that shows it",
};

const fail = (ctx: { json: boolean }, e: unknown, fallback: string): never => {
  const code = e instanceof HiveError || e instanceof HcpCliError ? e.code : fallback;
  const given = e instanceof HcpCliError ? e.exit : undefined;
  const fix = FIX[code.toUpperCase()] ?? (e instanceof HcpCliError ? e.fix : undefined) ?? (code === "BAD_REQUEST" ? helpFor() : undefined);
  return err(ctx, code, e instanceof Error ? e.message : String(e), given, fix);
};

/** Each `--attach`, in full: the parser keeps only the last of a flag given several times. */
function attachedFiles(rawArgs: readonly string[]): string[] {
  const given: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i]!;
    if (a === "--attach") given.push(rawArgs[++i] ?? "");
    else if (a.startsWith("--attach=")) given.push(a.slice("--attach=".length));
  }
  return given.filter(Boolean).map((f) => path.resolve(f));
}

const idArg = { id: { type: "positional", required: true, description: "comment id (from `hive review list`)" } } as const;
const jsonArg = { json: { type: "boolean" } } as const;

const where = (c: ReviewComment): string => {
  if (onBoard(c)) return `board ${c.board.on ?? `${c.board.x},${c.board.y}`}${c.board.what ? ` "${c.board.what}"` : ""}`.slice(0, 80);
  if (onPage(c)) return `${c.page.url} ${c.page.elements[0]?.name ?? "area"}`.slice(0, 80);
  return `${c.file}:${c.startLine}${c.endLine !== c.startLine ? `-${c.endLine}` : ""}`;
};

const oneLine = (c: ReviewComment): string =>
  `${c.id.padEnd(18)} ${statusOf(c).padEnd(9)} ${where(c).padEnd(32)} ${c.body.split("\n")[0]!.slice(0, 60)}`;

const detail = (c: ReviewComment, root: string): string => onCode(c)
  ? [`${c.id}  ${statusOf(c)}${c.summary ? ` — ${c.summary}` : ""}  by ${c.author} at ${c.at}`, nowOf(c), "", codeCommentText(c)].filter((l, i) => i !== 1 || l).join("\n")
  : onBoard(c) || onPage(c)
  ? [`${c.id}  ${statusOf(c)}${c.summary ? ` — ${c.summary}` : ""}  by ${c.author} at ${c.at}`, "", onBoard(c) ? boardNoteText(c) : pageNoteText(c, root)].join("\n")
  : [
    `${c.id}  ${statusOf(c)}${c.summary ? ` — ${c.summary}` : ""}`,
    `${where(c)}  ${c.side}  by ${c.author} at ${c.at}`,
    "",
    c.body,
    ...(c.replies ?? []).flatMap((r) => ["", `  ${r.author} at ${r.at}:`, `  ${r.body.replace(/\n/g, "\n  ")}`]),
  ].join("\n");

const onArg = { on: { type: "string", description: "page | board | diff | code: only notes on a page, pinned on the board, comments on a diff, or comments on a file's lines in the editor" } } as const;
const onOf = (v: unknown): "page" | "board" | "diff" | "code" | undefined => (v === "page" || v === "board" || v === "diff" || v === "code" ? v : undefined);

/** `on`: only comments on a page, or only on a diff, whatever the caller asks. */
const listOf = (on?: "notes") => defineCommand({
  meta: { name: "list", description: on ? "List the notes left on pages and pinned on the board (open by default)" : "List review comments (open by default)" },
  args: {
    file: { type: "string", description: "only this path" },
    status: { type: "string", description: "open | resolved | all (default open; open includes seen, resolved includes dismissed)" },
    ...onArg,
    ...jsonArg,
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const status = args.status === "resolved" || args.status === "all" ? args.status : "open";
      const list = await withNow(await listComments(await storeRoot(), { file: args.file || undefined, status, on: on ?? onOf(args.on) }));
      return ok(ctx, { comments: list }, () =>
        list.length === 0 ? "no comments" : list.map(oneLine).join("\n"));
    } catch (e) { return fail(ctx, e, "list_failed"); }
  },
});

const showCmd = defineCommand({
  meta: { name: "show", description: "Show one comment with its replies" },
  args: { ...idArg, ...jsonArg },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const root = await storeRoot();
      const found = (await readComments(root)).find((x) => x.id === args.id);
      if (!found) return err(ctx, "not_found", `no comment ${args.id}`);
      const [c] = await withNow([found]) as [ReviewComment];
      return ok(ctx, c, () => detail(c, root));
    } catch (e) { return fail(ctx, e, "show_failed"); }
  },
});

const replyCmd = defineCommand({
  meta: { name: "reply", description: "Reply to a review comment" },
  args: {
    ...idArg,
    message: { type: "positional", required: true, description: "what to say" },
    ...jsonArg,
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const c = await replyTo(await storeRoot(), String(args.id), {
        author: detectWho(), body: String(args.message), at: new Date().toISOString(),
      });
      if (!c) return err(ctx, "not_found", `no comment ${args.id}`);
      return ok(ctx, c, () => `replied to ${c.id}`);
    } catch (e) { return fail(ctx, e, "reply_failed"); }
  },
});

const resolveCmd = defineCommand({
  meta: { name: "resolve", description: "Mark a review comment resolved" },
  args: {
    ...idArg,
    summary: { type: "string", description: "how it was addressed" },
    attach: { type: "string", description: `a file to keep on the note as proof (${ATTACH_KINDS}); repeat for several` },
    ...jsonArg,
  },
  async run({ args, rawArgs }) {
    const ctx = { json: !!args.json };
    try {
      const c = await resolveComment(await storeRoot(), String(args.id), args.summary || undefined, attachedFiles(rawArgs));
      if (!c) return err(ctx, "not_found", `no comment ${args.id}`);
      return ok(ctx, c, () => `resolved ${c.id}`);
    } catch (e) { return fail(ctx, e, "resolve_failed"); }
  },
});

const seenCmd = defineCommand({
  meta: { name: "seen", description: "Say you have read an open comment and are on it" },
  args: { ...idArg, ...jsonArg },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const c = await markSeen(await storeRoot(), String(args.id));
      if (!c) return err(ctx, "not_found", `no comment ${args.id}`);
      return ok(ctx, c, () => `${c.id} is seen`);
    } catch (e) { return fail(ctx, e, "seen_failed"); }
  },
});

const dismissCmd = defineCommand({
  meta: { name: "dismiss", description: "Close a comment without doing it, saying why" },
  args: { ...idArg, reason: { type: "string", required: true, description: "why it is not done" }, ...jsonArg },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const c = await dismissComment(await storeRoot(), String(args.id), String(args.reason ?? ""));
      if (!c) return err(ctx, "not_found", `no comment ${args.id}`);
      return ok(ctx, c, () => `dismissed ${c.id}`);
    } catch (e) { return fail(ctx, e, "dismiss_failed"); }
  },
});

const reopenCmd = defineCommand({
  meta: { name: "reopen", description: "Reopen a resolved comment" },
  args: { ...idArg, ...jsonArg },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const c = await reopenComment(await storeRoot(), String(args.id));
      if (!c) return err(ctx, "not_found", `no comment ${args.id}`);
      return ok(ctx, c, () => `reopened ${c.id}`);
    } catch (e) { return fail(ctx, e, "reopen_failed"); }
  },
});

/** How long a note may take: its picture waits at most 10 s, and an element has to be named too. */
const NOTE_WITHIN_MS = 30_000;

/** `x,y,width,height`, in page pixels. */
function areaOf(given: string): PageBox {
  const n = given.split(",").map(Number);
  if (n.length !== 4 || !n.every(Number.isFinite)) throw new HcpCliError("BAD_REQUEST", `--area ${given}: give x,y,width,height in page pixels`, 2);
  return { x: n[0]!, y: n[1]!, width: n[2]!, height: n[3]! };
}

const addCmd = defineCommand({
  meta: { name: "add", description: "Leave a note on the page in a Browser tile, as a pin the person sees (needs the app)" },
  args: {
    selector: { type: "string", description: "a CSS selector matching the one element it is about" },
    area: { type: "string", description: "or the place it is about: x,y,width,height in page pixels" },
    body: { type: "string", required: true, description: "what you found" },
    intent: { type: "string", description: "fix | change | question" },
    tile: { type: "string", description: "the Browser tile (default: the one in your frame)" },
    attach: { type: "string", description: `a file to keep on the note as proof (${ATTACH_KINDS}); repeat for several` },
    ...jsonArg,
  },
  async run({ args, rawArgs }) {
    const ctx = { json: !!args.json };
    try {
      const files = attachedFiles(rawArgs);
      for (const file of files) await checkAttachment(file);
      const tile = args.tile || ownTile();
      if (!tile) throw new HcpCliError("NO_BROWSER_TILE", "this is no agent's tile, so no frame says which Browser tile: --tile names one", 5);
      const asked = {
        body: args.body,
        ...(args.intent ? { intent: args.intent } : {}),
        ...(args.selector ? { selector: args.selector } : {}),
        ...(args.area ? { area: areaOf(args.area) } : {}),
      };
      const d = await openDrive();
      let made: Result<"page.note">;
      try {
        made = await d.call("page.note", [tile, asked], NOTE_WITHIN_MS) as Result<"page.note">;
      } finally {
        d.close();
      }
      let note: ReviewComment = made.note;
      if (files.length) {
        // A note whose proof could not be kept is taken back, so the refusal leaves nothing.
        const kept = await attachToComment(made.kept, note.id, files).catch(async (e: unknown) => {
          await deleteComment(made.kept, note.id);
          throw e;
        });
        if (kept) note = kept;
      }
      return ok(ctx, note, () => `note ${note.id} on ${where(note)}, by ${note.author}`);
    } catch (e) { return fail(ctx, e, "add_failed"); }
  },
});

const WATCH_POLL_MS = 1000;
const WATCH_DEFAULT_S = 300;

/** Block until a comment appears that was not there when we started. This is
 *  what makes a review a loop: the agent waits for the human instead of
 *  being re-prompted. Exit 4 on timeout, like `hive ctl read`. */
const watchOf = (on?: "page" | "diff") => defineCommand({
  meta: { name: "watch", description: on === "page" ? "Wait for the next note on a page (exit 4 on timeout)" : "Wait for the next review comment (exit 4 on timeout)" },
  args: {
    timeout: { type: "string", description: `seconds to wait (default ${WATCH_DEFAULT_S})` },
    file: { type: "string", description: "only this path" },
    ...onArg,
    ...jsonArg,
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const root = await storeRoot();
      const filter = { file: args.file || undefined, status: "open" as const, on: on ?? onOf(args.on) };
      const seen = new Set((await listComments(root, filter)).map((c) => c.id));
      const seconds = Number.parseInt(String(args.timeout ?? ""), 10);
      const deadline = Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : WATCH_DEFAULT_S) * 1000;
      for (;;) {
        const fresh = (await listComments(root, filter)).filter((c) => !seen.has(c.id));
        if (fresh.length > 0) {
          const now = await withNow(fresh);
          return ok(ctx, { comments: now }, () => now.map((c) => detail(c, root)).join("\n\n"));
        }
        if (Date.now() >= deadline) {
          process.exitCode = 4;
          return ok(ctx, { comments: [] }, () => "no new comments");
        }
        await new Promise((r) => setTimeout(r, WATCH_POLL_MS));
      }
    } catch (e) { return fail(ctx, e, "watch_failed"); }
  },
});

export const reviewCmd = defineCommand({
  meta: { name: "review", description: "Review comments left on a diff or on code in the editor, and notes left on a page" },
  subCommands: {
    list: listOf(), show: showCmd, reply: replyCmd, seen: seenCmd,
    resolve: resolveCmd, dismiss: dismissCmd, reopen: reopenCmd, watch: watchOf(),
  },
});

/** `hive ctl notes`: the notes left on a page in a Browser tile, which are review comments on a
 *  page, answered the same way. */
export const notesCmd = defineCommand({
  meta: { name: "notes", description: "Notes on a page in a Browser tile or pinned on the board: leave one on a page, list, read and answer them" },
  subCommands: {
    add: addCmd, list: listOf("notes"), show: showCmd, seen: seenCmd, done: resolveCmd, dismiss: dismissCmd,
    reply: replyCmd, reopen: reopenCmd, watch: watchOf("page"),
  },
});
