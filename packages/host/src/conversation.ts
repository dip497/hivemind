/**
 * What an agent and the person said to each other, as the agent keeps it in its session file
 * (M5, spec/agents.md "Conversation"): Claude Code's records read as the entries the person's phone
 * shows, from the end of the file, then what is written next as it comes. Electron-free.
 */
import fs from "node:fs";
import type { ConversationEntry as Entry } from "@hivemind/workspace-api/agents";

/** The entries said, and how far into the file they go (bytes, at the end of a line). */
export interface Said {
  entries: Entry[];
  cursor: number;
}

/** What a tool's use is about: the first of these in its input that is text. */
const ABOUT_KEYS = ["file_path", "path", "command", "pattern", "url", "query", "description"];
const ABOUT_MAX = 120;
const RESULT_MAX = 2000;
/** How much of the end of the file is read, and how many of its entries kept, when asked from no
 *  cursor; and the most read past one. */
export const TAIL_BYTES = 1024 * 1024;
export const TAIL_ENTRIES = 200;

type Block = { type?: unknown; text?: unknown; id?: unknown; name?: unknown; input?: unknown; tool_use_id?: unknown; content?: unknown; is_error?: unknown };

const isText = (v: unknown): v is string => typeof v === "string";

/** What a tool's use is about, from its input; undefined when none of its keys is text. */
function aboutOf(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = ABOUT_KEYS.map((k) => (input as Record<string, unknown>)[k]).find(isText);
  return value === undefined ? undefined : value.split("\n")[0]!.slice(0, ABOUT_MAX);
}

/** What a tool gave back, as text: itself, or its text blocks joined. */
function resultText(content: unknown): string {
  if (isText(content)) return content;
  if (!Array.isArray(content)) return "";
  return (content as Block[]).filter((b) => b?.type === "text" && isText(b.text)).map((b) => b.text as string).join("\n");
}

/** The entries of one block of a record, said by `kind` (`user` or `assistant`). */
function fromBlock(kind: string, block: Block, id: string, at: number): Entry | null {
  if (kind === "user" && block.type === "text" && isText(block.text)) return { id, at, who: "person", text: block.text };
  if (kind === "assistant" && block.type === "text" && isText(block.text)) return { id, at, who: "agent", text: block.text };
  if (kind === "assistant" && block.type === "tool_use" && isText(block.id) && isText(block.name)) {
    const about = aboutOf(block.input);
    return { id, at, who: "agent", tool: { id: block.id, name: block.name, ...(about === undefined ? {} : { about }) } };
  }
  if (kind === "user" && block.type === "tool_result" && isText(block.tool_use_id)) {
    const text = resultText(block.content).slice(0, RESULT_MAX);
    return { id, at, who: "tool", result: { of: block.tool_use_id, text, ...(block.is_error === true ? { error: true as const } : {}) } };
  }
  return null;
}

/** The entries Claude Code's session file says in `lines`. */
export function claudeEntries(lines: readonly string[]): Entry[] {
  const entries: Entry[] = [];
  for (const line of lines) {
    let r: { type?: unknown; uuid?: unknown; timestamp?: unknown; isSidechain?: unknown; isMeta?: unknown; message?: { content?: unknown } };
    try { r = JSON.parse(line) as typeof r; } catch { continue; }
    if (!r || (r.type !== "user" && r.type !== "assistant") || r.isSidechain === true || r.isMeta === true) continue;
    const at = isText(r.timestamp) ? Date.parse(r.timestamp) : NaN;
    if (!isText(r.uuid) || Number.isNaN(at)) continue;
    const content = r.message?.content;
    if (isText(content)) {
      if (r.type === "user") entries.push({ id: r.uuid, at, who: "person", text: content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    const blocks = content as Block[];
    blocks.forEach((block, i) => {
      const entry = block && fromBlock(r.type as string, block, blocks.length > 1 ? `${r.uuid}/${i}` : (r.uuid as string), at);
      if (entry) entries.push(entry);
    });
  }
  return entries;
}

/** The complete lines of `file` from `start` to `end` (bytes), and where the last of them ends. */
function linesBetween(file: string, start: number, end: number): { lines: string[]; through: number } {
  if (end <= start) return { lines: [], through: start };
  const fd = fs.openSync(file, "r");
  try {
    const bytes = Buffer.alloc(end - start);
    const got = fs.readSync(fd, bytes, 0, bytes.length, start);
    const last = bytes.subarray(0, got).lastIndexOf(0x0a);
    if (last < 0) return { lines: [], through: start };
    return { lines: bytes.subarray(0, last).toString("utf8").split("\n").filter(Boolean), through: start + last + 1 };
  } finally {
    fs.closeSync(fd);
  }
}

/** What the session file `file` says after `cursor`, of what came after it the last 1 MiB; with no
 *  cursor, the last 200 entries of its last 1 MiB. */
export function readConversation(file: string, cursor?: number): Said {
  let size: number;
  try { size = fs.statSync(file).size; } catch { return { entries: [], cursor: cursor ?? 0 }; }
  const from = cursor !== undefined && cursor <= size ? Math.max(cursor, size - TAIL_BYTES) : Math.max(0, size - TAIL_BYTES);
  const { lines, through } = linesBetween(file, from, size);
  // Read from inside the file, the first line is a piece of one: never a record.
  const whole = from === cursor || from === 0 ? lines : lines.slice(1);
  const entries = claudeEntries(whole);
  return { entries: cursor === undefined ? entries.slice(-TAIL_ENTRIES) : entries, cursor: through };
}

/** Follow the session file `file` from `cursor`: `said` is handed what is written to it next, as it
 *  comes. Stop it with what it returns. */
export function followConversation(file: string, cursor: number, said: (s: Said) => void): () => void {
  let at = cursor;
  let reading = false;
  const read = () => {
    if (reading) return;
    reading = true;
    try {
      const size = fs.statSync(file).size;
      if (size < at) at = size; // rewritten shorter: from its end on
      const { lines, through } = linesBetween(file, at, size);
      at = through;
      const entries = claudeEntries(lines);
      if (entries.length) said({ entries, cursor: at });
    } catch { /* gone for now: read again as it comes back */ } finally {
      reading = false;
    }
  };
  let watcher: fs.FSWatcher | null = null;
  try { watcher = fs.watch(file, read); } catch { /* not watchable here: the poll below reads it */ }
  // A watch may miss a write on some file systems: a slow poll reads what it missed.
  const poll = setInterval(read, 1000);
  return () => {
    watcher?.close();
    clearInterval(poll);
  };
}
