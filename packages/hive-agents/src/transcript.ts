/**
 * An agent's session file read as a conversation (spec/agents.md "Conversation"), as its manifest
 * maps the file's records (`session.transcript`): what the person, the agent and its tools said,
 * whichever agent keeps it. Nothing here knows one agent's format; the manifest does.
 */
import { setValueAt, valueAt } from "./field-path.js";
import type { AgentTranscript, TranscriptAsks, TranscriptNotice, TranscriptRule } from "./types.js";

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
  | { id: string; at: number; who: "tool"; result: { of: string; text: string; error?: true } }
  | { id: string; at: number; who: "program"; notice: Notice };

/** A line the agent's own program wrote into the conversation, in the person's words; `quiet`: it
 *  should barely register; `detail`: what it says more, once opened. */
export interface Notice {
  text: string;
  quiet?: true;
  detail?: string;
}

const ABOUT_MAX = 120;
/** A tool's `about` read whole: what a wait on it shows. */
const WHOLE_ABOUT_MAX = 4000;
const RESULT_MAX = 2000;
/** The most questions, options and characters an ask keeps. */
const ASKED_MAX = 4;
const OPTIONS_MAX = 9;
const ASKED_TEXT_MAX = 300;
/** The most characters of a notice's line, and of what it says more. */
const NOTICE_MAX = 160;
const NOTICE_DETAIL_MAX = 4000;

const isText = (v: unknown): v is string => typeof v === "string";

/** Whether `from` holds each value `wants` names. */
function fits(from: unknown, wants: Record<string, unknown> | undefined): boolean {
  return !wants || Object.entries(wants).every(([path, value]) => valueAt(from, path) === value);
}

/** Whether `from` holds any value `wants` names. */
function holdsAny(from: unknown, wants: Record<string, unknown> | undefined): boolean {
  return !!wants && Object.entries(wants).some(([path, value]) => valueAt(from, path) === value);
}

/** The elements `text` is made of, each by name its inside, when it is those `names` and nothing
 *  else, the first always; null when anything else is there. An element's end is its last: what it
 *  holds may quote its tag. */
function elementsOf(text: string, names: readonly string[]): Map<string, string> | null {
  const found = new Map<string, string>();
  for (let at = text.search(/\S/); at >= 0 && at < text.length;) {
    const name = names.find((n) => text.startsWith(`<${n}>`, at));
    if (!name || found.has(name)) return null;
    const start = at + name.length + 2;
    const end = text.lastIndexOf(`</${name}>`);
    if (end < start) return null;
    found.set(name, text.slice(start, end));
    const after = text.slice(end + name.length + 3).search(/\S/);
    if (after < 0) break;
    at = end + name.length + 3 + after;
  }
  return found.has(names[0]!) ? found : null;
}

/** What `path`, an element or `element.child`, holds in `found`; a child to its first end when
 *  `firstEnd`, as a short line is, else to its last. */
function elementAt(found: Map<string, string>, path: string, firstEnd: boolean): string | undefined {
  const [name, child] = path.split(".") as [string, string | undefined];
  const inside = found.get(name);
  if (inside === undefined || child === undefined) return inside;
  const open = inside.indexOf(`<${child}>`);
  if (open < 0) return undefined;
  const start = open + child.length + 2;
  const end = firstEnd ? inside.indexOf(`</${child}>`, start) : inside.lastIndexOf(`</${child}>`);
  return end < start ? undefined : inside.slice(start, end);
}

/** The parts of `text` a saying's `when` names, when it says that; null when it does not. */
function partsIn(text: string, when: string): Record<string, string> | null {
  const open = when.endsWith("*");
  const pieces = (open ? when.slice(0, -1) : when).split(/\{([\w-]+)\}/);
  const parts: Record<string, string> = {};
  if (!text.startsWith(pieces[0]!)) return null;
  let at = pieces[0]!.length;
  for (let i = 1; i < pieces.length; i += 2) {
    const after = pieces[i + 1]!;
    // A part goes to where what follows it is; last with nothing after it, to the end.
    const end = after === "" && i + 2 >= pieces.length ? text.length : text.indexOf(after, at);
    if (end < 0) return null;
    parts[pieces[i]!] = text.slice(at, end);
    at = end + after.length;
  }
  return open || at === text.length ? parts : null;
}

/** Text a terminal would colour or move by, as the text it shows. */
const plainText = (text: string): string =>
  // eslint-disable-next-line no-control-regex
  text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trim();

/** What `rule` makes of `from`: the entry, null when what it reads says nothing, undefined when it
 *  does not read this. */
function noticeOf(rule: TranscriptNotice, from: unknown, id: string, at: number): TranscriptEntry | null | undefined {
  const text = rule.text === undefined ? undefined : valueAt(from, rule.text);
  if (rule.text !== undefined && !isText(text)) return undefined;
  const found = rule.elements && isText(text) ? elementsOf(text, rule.elements) : new Map<string, string>();
  if (!found) return undefined;
  const read = rule.reads === undefined ? text : elementAt(found, rule.reads, true);
  for (const saying of rule.says) {
    const parts = saying.when === undefined ? {} : isText(read) ? partsIn(read.trim(), saying.when) : null;
    if (!parts) continue;
    const said = saying.say.replace(/\{([\w.-]+)\}/g, (_, name: string) => parts[name] ?? elementAt(found, name, true) ?? "");
    const line = plainText(said);
    if (!line) return null;
    if (rule.who) return { id, at, who: "person", text: line };
    const detail = rule.detail?.map((d) => plainText(elementAt(found, d, false) ?? "")).filter(Boolean).join("\n\n");
    return {
      id, at, who: "program",
      notice: { text: line.replace(/\s+/g, " ").slice(0, NOTICE_MAX), ...(saying.quiet ? { quiet: true as const } : {}), ...(detail ? { detail: detail.slice(0, NOTICE_DETAIL_MAX) } : {}) },
    };
  }
  return undefined;
}

/** `text` with the element `name` taken off wherever it wraps something whole, its tags and the
 *  line breaks against them; an open tag with no end of the same attributes stays as written. */
function unwrapped(text: string, name: string): string {
  let out = text;
  for (let from = out.indexOf(`<${name}`); from >= 0; from = out.indexOf(`<${name}`, from)) {
    const close = out.indexOf(">", from);
    const attributes = close < 0 ? "" : out.slice(from + name.length + 1, close);
    if (close < 0 || (attributes !== "" && !attributes.startsWith(" "))) {
      from += 1;
      continue;
    }
    const end = out.indexOf(`</${name}${attributes}>`, close);
    if (end < 0) {
      from = close;
      continue;
    }
    const inner = out.slice(close + 1, end).replace(/^\n/, "").replace(/\n$/, "");
    out = out.slice(0, from) + inner + out.slice(end + name.length + attributes.length + 3);
    from += inner.length;
  }
  return out;
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
    for (const [path, value] of [[rule.tool.id, ""], [rule.tool.name, name], [rule.tool.input, input]] as const) setValueAt(use, path, value);
    const entry = entryOf(rule, use, "", 0, true, false);
    if (entry && "tool" in entry && entry.tool.about !== undefined) return entry.tool.about;
  }
  return undefined;
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
    const notices = transcript.notices?.filter((n) => fits(record, n.require) && !holdsAny(record, n.unless)) ?? [];
    const asNotice = (from: unknown, of: string, item?: { each: string }): { entry: TranscriptEntry | null } | undefined => {
      for (const n of notices) {
        if (n.each !== item?.each || !fits(from, n.item)) continue;
        const entry = noticeOf(n, from, of, at);
        if (entry !== undefined) return { entry };
      }
      return undefined;
    };
    const told = asNotice(record, id);
    if (told) {
      if (told.entry) entries.push(told.entry);
      continue;
    }
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
        const of = items.length > 1 ? `${id}/${i}` : id;
        const noticed = asNotice(item, of, { each: rule.each! });
        const reader = readers.find((r) => fits(item, r.item));
        const entry = noticed ? noticed.entry : reader && entryOf(reader, item, of, at, whole, full);
        if (entry) entries.push(entry);
      });
    }
  }
  if (transcript.unwrap?.length) {
    for (const e of entries) {
      if (e.who === "person") e.text = transcript.unwrap.reduce(unwrapped, e.text);
    }
  }
  return entries;
}
