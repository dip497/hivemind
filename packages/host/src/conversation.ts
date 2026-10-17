/**
 * What an agent and the person said to each other, as the agent keeps it in its session file
 * (M5, spec/agents.md "Conversation"): the file's records read as the agent's manifest maps them
 * (`session.transcript`), from the end of the file, then what is written next as it comes.
 * Electron-free.
 */
import fs from "node:fs";
import { transcriptEntries, type AgentTranscript, type TranscriptEntry } from "@hivemind/agents/node";
import type { ConversationEntry as Entry, ToolAsked, ToolUse } from "@hivemind/workspace-api/agents";

/** The entries said, and how far into the file they go (bytes, at the end of a line). */
export interface Said {
  entries: Entry[];
  cursor: number;
}

/** How much of the end of the file is read, and how many of its entries kept, when asked from no
 *  cursor; and the most read past one. */
export const TAIL_BYTES = 1024 * 1024;
export const TAIL_ENTRIES = 200;

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

/** Where a conversation of a session file `size` bytes long is read from: after `cursor`, of the
 *  last 1 MiB. */
export function conversationStart(size: number, cursor?: number): number {
  return cursor !== undefined && cursor <= size ? Math.max(cursor, size - TAIL_BYTES) : Math.max(0, size - TAIL_BYTES);
}

/** What the session file `file`, read as `format` maps it, says after `cursor`, of what came after
 *  it the last 1 MiB; with no cursor, the last 200 entries of its last 1 MiB. */
export function readConversation(file: string, format: AgentTranscript, cursor?: number): Said {
  let size: number;
  try { size = fs.statSync(file).size; } catch { return { entries: [], cursor: cursor ?? 0 }; }
  const from = conversationStart(size, cursor);
  const { lines, through } = linesBetween(file, from, size);
  // Read from inside the file, the first line is a piece of one: never a record.
  const whole = from === cursor || from === 0 ? lines : lines.slice(1);
  const entries = transcriptEntries(format, whole);
  return { entries: cursor === undefined ? entries.slice(-TAIL_ENTRIES) : entries, cursor: through };
}

/** How much of the end of the file is read first for the last thing said; four times more each time
 *  it says nothing, up to the most. */
const LAST_BYTES = 64 * 1024;
const LAST_BYTES_MAX = 4 * 1024 * 1024;
/** The longest last thing said told. */
const LAST_MAX = 160;

/** The last thing said in the session file `file`, read as `format` maps it, in a line: the first
 *  line of what was last said, or the tool last used and what it is about; undefined when the last
 *  4 MiB say neither. An agent may write records for itself after its last words (each resume
 *  does), so the end is read wider until it says something. */
export function lastSaid(file: string, format: AgentTranscript): string | undefined {
  let size: number;
  try { size = fs.statSync(file).size; } catch { return undefined; }
  for (let bytes = LAST_BYTES; ; bytes *= 4) {
    const from = Math.max(0, size - bytes);
    const { lines } = linesBetween(file, from, size);
    const entries = transcriptEntries(format, from === 0 ? lines : lines.slice(1));
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!;
      const line = "text" in e ? e.text.split("\n").map((l) => l.trim()).find(Boolean) : "tool" in e ? [e.tool.name, e.tool.about].filter(Boolean).join(" · ") : undefined;
      if (line) return [...line].slice(0, LAST_MAX).join("");
    }
    if (from === 0 || bytes >= LAST_BYTES_MAX) return undefined;
  }
}

/** How much of the end of the file is read for the tool use an agent waits on. */
const PENDING_BYTES = 256 * 1024;

/** The tool use the session file `file`, read as `format` maps it, says the agent waits on: of the
 *  tool uses since the last thing said, the first that nothing was given back for yet, what it is
 *  about whole; undefined when there is none. */
export function pendingTool(file: string, format: AgentTranscript): ToolAsked | undefined {
  let size: number;
  try { size = fs.statSync(file).size; } catch { return undefined; }
  const from = Math.max(0, size - PENDING_BYTES);
  const { lines } = linesBetween(file, from, size);
  const entries = transcriptEntries(format, from === 0 ? lines : lines.slice(1), { whole: true });
  const said = entries.findLastIndex((e) => "text" in e);
  const since = entries.slice(said + 1);
  const answered = new Set(since.flatMap((e) => ("result" in e ? [e.result.of] : [])));
  const use = since.find((e): e is Extract<Entry, { tool: unknown }> => "tool" in e && !answered.has(e.tool.id));
  if (!use) return undefined;
  const { id: _id, ...tool } = use.tool;
  return tool;
}

/** The most characters of a tool's input, and of what it gave back, sent unfolded. */
export const TOOL_MAX = 256 * 1024;

/** How much of a session file is read at a time looking for a tool use, from its end. */
const TOOL_CHUNK = 4 * 1024 * 1024;

/** The lines of `file` after byte `floor` that name `named`, read back from its end a chunk at a
 *  time, in the file's order: from the last chunk back to the first that gives what `enough` asks. */
function linesNaming(file: string, named: Buffer, enough: (lines: string[]) => boolean, floor: number): string[] {
  const fd = fs.openSync(file, "r");
  try {
    const found: string[] = [];
    // The start of the line the chunk after this one began inside of.
    let carry = Buffer.alloc(0);
    for (let end = fs.fstatSync(fd).size; end > floor; ) {
      // From the byte before the floor, which says whether a whole line starts there.
      const start = Math.max(floor && floor - 1, end - TOOL_CHUNK);
      const bytes = Buffer.alloc(end - start + carry.length);
      fs.readSync(fd, bytes, 0, end - start, start);
      carry.copy(bytes, end - start);
      end = start;
      // Read from inside the file, the first line is a piece of one: kept for the chunk before.
      const from = start === 0 ? 0 : bytes.indexOf(0x0a) + 1;
      if (from === 0 && start > 0) { carry = bytes; continue; }
      carry = bytes.subarray(0, from);
      const here: string[] = [];
      for (let at = bytes.indexOf(named, from); at >= 0; ) {
        const lineStart = bytes.lastIndexOf(0x0a, at) + 1;
        const lineEnd = bytes.indexOf(0x0a, at);
        here.push(bytes.subarray(lineStart, lineEnd < 0 ? bytes.length : lineEnd).toString("utf8"));
        at = lineEnd < 0 ? -1 : bytes.indexOf(named, lineEnd);
      }
      if (!here.length) continue;
      found.unshift(...here);
      if (enough(found)) break;
    }
    return found;
  } finally {
    fs.closeSync(fd);
  }
}

/** The tool use `use` in the session file `file`, read as `format` maps it, unfolded: the records
 *  that name it, read whole, back from the end of the file to the one that says it was used, not
 *  before byte `from`; undefined when none says it was. */
export function toolUse(file: string, format: AgentTranscript, use: string, from = 0): ToolUse | undefined {
  const named = Buffer.from(JSON.stringify(use));
  const usedIn = (lines: string[]) => transcriptEntries(format, lines, { full: true })
    .find((e): e is Extract<TranscriptEntry, { tool: unknown }> => "tool" in e && e.tool.id === use)?.tool;
  let lines: string[];
  try { lines = linesNaming(file, named, (l) => !!usedIn(l), from); } catch { return undefined; }
  const entries = transcriptEntries(format, lines, { full: true });
  const tool = entries.find((e): e is Extract<TranscriptEntry, { tool: unknown }> => "tool" in e && e.tool.id === use)?.tool;
  if (!tool) return undefined;
  const result = entries.find((e): e is Extract<TranscriptEntry, { result: unknown }> => "result" in e && e.result.of === use)?.result;
  let truncated = false;
  const cut = (text: string) => (text.length > TOOL_MAX ? ((truncated = true), text.slice(0, TOOL_MAX)) : text);
  return {
    name: tool.name,
    ...(tool.about !== undefined ? { about: cut(tool.about) } : {}),
    ...(tool.input !== undefined ? { input: cut(tool.input) } : {}),
    ...(result ? { result: { text: cut(result.text), ...(result.error ? { error: true as const } : {}) } } : {}),
    ...(truncated ? { truncated: true as const } : {}),
  };
}

/** Follow the session file `file`, read as `format` maps it, from `cursor`: `said` is handed what is
 *  written to it next, as it comes. Stop it with what it returns. */
export function followConversation(file: string, format: AgentTranscript, cursor: number, said: (s: Said) => void): () => void {
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
      const entries = transcriptEntries(format, lines);
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
