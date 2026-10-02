/**
 * An agent's session file read as a conversation (spec/agents.md "Conversation"), as its manifest
 * maps the file's records (`session.transcript`): what the person, the agent and its tools said,
 * whichever agent keeps it. Nothing here knows one agent's format; the manifest does.
 */
import { valueAt } from "./field-path.js";
import type { AgentTranscript, TranscriptRule } from "./types.js";

/** One thing said, as spec/agents.md sends it. */
export type TranscriptEntry =
  | { id: string; at: number; who: "person" | "agent"; text: string }
  | { id: string; at: number; who: "agent"; tool: { id: string; name: string; about?: string } }
  | { id: string; at: number; who: "tool"; result: { of: string; text: string; error?: true } };

const ABOUT_MAX = 120;
const RESULT_MAX = 2000;

const isText = (v: unknown): v is string => typeof v === "string";

/** Whether `from` holds each value `wants` names. */
function fits(from: unknown, wants: Record<string, unknown> | undefined): boolean {
  return !wants || Object.entries(wants).every(([path, value]) => valueAt(from, path) === value);
}

/** What a tool gave back, as text: itself, or the `text` of each item of a list, a line each. */
function textOf(given: unknown): string {
  if (isText(given)) return given;
  if (!Array.isArray(given)) return "";
  return given.map((item) => valueAt(item, "text")).filter(isText).join("\n");
}

/** What `rule` reads in `from`, the record or an item of a list in it, as the entry `id`, said at
 *  `at`; null when what it names is not there. */
function entryOf(rule: TranscriptRule, from: unknown, id: string, at: number): TranscriptEntry | null {
  if (rule.text !== undefined) {
    const text = valueAt(from, rule.text);
    return isText(text) ? { id, at, who: rule.who!, text } : null;
  }
  if (rule.tool) {
    const [use, name] = [valueAt(from, rule.tool.id), valueAt(from, rule.tool.name)];
    if (!isText(use) || !isText(name)) return null;
    const about = rule.tool.about?.map((path) => valueAt(from, path)).find(isText);
    return { id, at, who: "agent", tool: { id: use, name, ...(about === undefined ? {} : { about: about.split("\n")[0]!.slice(0, ABOUT_MAX) }) } };
  }
  if (rule.result) {
    const of = valueAt(from, rule.result.of);
    if (!isText(of)) return null;
    const error = rule.result.error !== undefined && valueAt(from, rule.result.error) === true;
    return { id, at, who: "tool", result: { of, text: textOf(valueAt(from, rule.result.text)).slice(0, RESULT_MAX), ...(error ? { error: true as const } : {}) } };
  }
  return null;
}

/** What the records in `lines` say, read as `transcript` maps them, in order. An entry read from
 *  one item of a list of several is its record's id, `/`, and the item's index. */
export function transcriptEntries(transcript: AgentTranscript, lines: readonly string[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const line of lines) {
    let record: unknown;
    try { record = JSON.parse(line); } catch { continue; }
    if (!record || typeof record !== "object") continue;
    if (transcript.skipWhen && Object.entries(transcript.skipWhen).some(([path, value]) => valueAt(record, path) === value)) continue;
    const id = valueAt(record, transcript.id);
    const time = valueAt(record, transcript.at);
    const at = isText(time) ? Date.parse(time) : NaN;
    if (!isText(id) || Number.isNaN(at)) continue;
    const rules = transcript.said.filter((rule) => fits(record, rule.require));
    const walked = new Set<string>();
    for (const rule of rules) {
      if (rule.each === undefined) {
        const entry = entryOf(rule, record, id, at);
        if (entry) entries.push(entry);
        continue;
      }
      if (walked.has(rule.each)) continue;
      walked.add(rule.each);
      const items = valueAt(record, rule.each);
      if (!Array.isArray(items)) continue;
      const readers = rules.filter((r) => r.each === rule.each);
      items.forEach((item, i) => {
        const reader = readers.find((r) => fits(item, r.item));
        const entry = reader && entryOf(reader, item, items.length > 1 ? `${id}/${i}` : id, at);
        if (entry) entries.push(entry);
      });
    }
  }
  return entries;
}
