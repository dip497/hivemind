/**
 * Read a Claude Code transcript JSONL and extract the agent's final assistant
 * message as plain text — the clean "reply" handed back to a driver via
 * agent.read (far better than scraping ANSI terminal bytes).
 *
 * The transcript is one JSON object per line. Entries of interest look like
 * `{ type:"assistant", message:{ role:"assistant", content:[ {type:"text",text}
 * | {type:"tool_use",…} ] } }`. We take the LAST assistant entry that carries at
 * least one text block and join its text blocks. Defensive against shape drift:
 * we also accept a top-level `role` and a string `content`.
 *
 * Perf: the final turn is at the END of the file, and transcripts grow without
 * bound over a session. So we read a bounded TAIL first and only full-read if the
 * tail holds no assistant text — avoids the O(n²) full-file read per turn that
 * the HCP review flagged.
 */
import fs from "node:fs";

type Block = { type?: string; text?: string };
type Entry = {
  type?: string;
  role?: string;
  message?: { role?: string; content?: Block[] | string };
};

const TAIL_BYTES = 256 * 1024;

function textOf(content: Block[] | string | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

function isAssistant(e: Entry): boolean {
  return e.type === "assistant" || e.role === "assistant" || e.message?.role === "assistant";
}

/** Last non-empty assistant text within a chunk of JSONL, scanning backwards. */
function scanLast(raw: string): string | null {
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let e: Entry;
    try {
      e = JSON.parse(line) as Entry;
    } catch {
      continue;
    }
    if (!isAssistant(e)) continue;
    const text = textOf(e.message?.content).trim();
    if (text) return text;
  }
  return null;
}

/** Final assistant reply, or null if unreadable / none found. Never throws. */
export function readLastAssistantMessage(transcriptPath: string): string | null {
  try {
    const size = fs.statSync(transcriptPath).size;
    if (size > TAIL_BYTES) {
      const fd = fs.openSync(transcriptPath, "r");
      let tail: string;
      try {
        const buf = Buffer.alloc(TAIL_BYTES);
        const read = fs.readSync(fd, buf, 0, TAIL_BYTES, size - TAIL_BYTES);
        tail = buf.toString("utf8", 0, read);
      } finally {
        fs.closeSync(fd);
      }
      // Drop the first (likely partial) line so we never JSON.parse a fragment.
      const nl = tail.indexOf("\n");
      const found = scanLast(nl >= 0 ? tail.slice(nl + 1) : tail);
      if (found != null) return found;
      // Tail held no assistant text (huge final turn) → fall through to full read.
    }
    return scanLast(fs.readFileSync(transcriptPath, "utf8"));
  } catch {
    return null;
  }
}
