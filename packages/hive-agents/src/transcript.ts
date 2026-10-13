/**
 * An agent's session file read as a conversation (spec/agents.md "Conversation"), as its manifest
 * maps the file's records (`session.transcript`): what the person, the agent and its tools said,
 * whichever agent keeps it. Nothing here knows one agent's format; the manifest does.
 */
import { valueAt } from "./field-path.js";
import type { AgentTranscript, TranscriptAsks, TranscriptRule } from "./types.js";

/** A question a tool use asks the person, and the options to choose from; `descriptions`: what
 *  each option means, by its place ("" for one that says nothing); `many`: several may be. */
export interface Asked {
  question: string;
  options: string[];
  descriptions?: string[];
  many?: true;
}

/** One thing said, as spec/agents.md sends it. */
export type TranscriptEntry =
  | { id: string; at: number; who: "person" | "agent"; text: string }
  | { id: string; at: number; who: "agent"; tool: { id: string; name: string; about?: string; asks?: Asked[]; input?: string } }
  | { id: string; at: number; who: "tool"; result: { of: string; text: string; error?: true } };

const ABOUT_MAX = 120;
/** A tool's `about` read whole: what a wait on it shows. */
const WHOLE_ABOUT_MAX = 4000;
const RESULT_MAX = 2000;
/** The most questions, options and characters an ask keeps. */
const ASKED_MAX = 4;
const OPTIONS_MAX = 9;
const ASKED_TEXT_MAX = 300;

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

/** The questions `from`, a tool use, asks as `asks` maps them; undefined when it asks none. */
export function askedIn(from: unknown, asks: TranscriptAsks): Asked[] | undefined {
  const list = valueAt(from, asks.list);
  if (!Array.isArray(list)) return undefined;
  const asked = list.slice(0, ASKED_MAX).flatMap((q): Asked[] => {
    const question = valueAt(q, asks.question);
    const options = valueAt(q, asks.options);
    if (!isText(question) || !Array.isArray(options)) return [];
    const labelled = options.slice(0, OPTIONS_MAX).filter((o) => isText(valueAt(o, asks.label)));
    const labels = labelled.map((o) => (valueAt(o, asks.label) as string).slice(0, ASKED_TEXT_MAX));
    const descriptions = labelled.map((o) => {
      const d = asks.description === undefined ? undefined : valueAt(o, asks.description);
      return isText(d) ? d.slice(0, ASKED_TEXT_MAX) : "";
    });
    const many = asks.many !== undefined && valueAt(q, asks.many) === true;
    return [{ question: question.slice(0, ASKED_TEXT_MAX), options: labels, ...(descriptions.some((d) => d) ? { descriptions } : {}), ...(many ? { many: true as const } : {}) }];
  });
  return asked.length ? asked : undefined;
}

/** What `rule` reads in `from`, the record or an item of a list in it, as the entry `id`, said at
 *  `at`; null when what it names is not there. */
function entryOf(rule: TranscriptRule, from: unknown, id: string, at: number, whole: boolean, full: boolean): TranscriptEntry | null {
  if (rule.text !== undefined) {
    const text = valueAt(from, rule.text);
    return isText(text) ? { id, at, who: rule.who!, text } : null;
  }
  if (rule.tool) {
    const [use, name] = [valueAt(from, rule.tool.id), valueAt(from, rule.tool.name)];
    if (!isText(use) || !isText(name)) return null;
    const about = rule.tool.about?.map((path) => valueAt(from, path)).find(isText);
    const asks = rule.tool.asks && askedIn(from, rule.tool.asks);
    const cut = about === undefined ? undefined : full ? about : whole ? about.slice(0, WHOLE_ABOUT_MAX) : about.split("\n")[0]!.slice(0, ABOUT_MAX);
    const given = full && rule.tool.input !== undefined ? valueAt(from, rule.tool.input) : undefined;
    const input = given === undefined ? undefined : isText(given) ? given : JSON.stringify(given, null, 2);
    return { id, at, who: "agent", tool: { id: use, name, ...(cut === undefined ? {} : { about: cut }), ...(asks ? { asks } : {}), ...(input === undefined ? {} : { input }) } };
  }
  if (rule.result) {
    const of = valueAt(from, rule.result.of);
    if (!isText(of)) return null;
    const error = rule.result.error !== undefined && valueAt(from, rule.result.error) === true;
    const text = textOf(valueAt(from, rule.result.text));
    return { id, at, who: "tool", result: { of, text: full ? text : text.slice(0, RESULT_MAX), ...(error ? { error: true as const } : {}) } };
  }
  return null;
}

/** What the tool use `name`, given `input` (as an agent's hook gives a use it waits on, before its
 *  session file records it), is about, read as `transcript` reads a use it records: whole, as a
 *  wait shows it; undefined when no rule reads where a use's input is, or it names nothing. */
export function toolAbout(transcript: AgentTranscript, name: string, input: unknown): string | undefined {
  for (const rule of transcript.said) {
    if (!rule.tool?.input || !rule.tool.about) continue;
    const use: Record<string, unknown> = {};
    for (const [path, value] of [[rule.tool.id, ""], [rule.tool.name, name], [rule.tool.input, input]] as const) put(use, path, value);
    const entry = entryOf(rule, use, "", 0, true, false);
    if (entry && "tool" in entry && entry.tool.about !== undefined) return entry.tool.about;
  }
  return undefined;
}

function put(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let cur = obj;
  for (const key of keys.slice(0, -1)) cur = (cur[key] ??= {}) as Record<string, unknown>;
  cur[keys.at(-1)!] = value;
}

/** What the records in `lines` say, read as `transcript` maps them, in order. An entry read from
 *  one item of a list of several is its record's id, `/`, and the item's index. A tool's `about`
 *  is its first line, cut short; `whole`, all of it, as a wait on it shows it; `full`, a tool use
 *  and what it gave back uncut, its `input` with them (text as it is, else JSON), as unfolded. */
export function transcriptEntries(transcript: AgentTranscript, lines: readonly string[], { whole = false, full = false }: { whole?: boolean; full?: boolean } = {}): TranscriptEntry[] {
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
        const entry = entryOf(rule, record, id, at, whole, full);
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
        const entry = reader && entryOf(reader, item, items.length > 1 ? `${id}/${i}` : id, at, whole, full);
        if (entry) entries.push(entry);
      });
    }
  }
  return entries;
}
