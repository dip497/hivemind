/**
 * What a terminal's text links to, and the folder its shell is in. Pure, so the per-line work is
 * one regex over the line under the pointer, and the shell's folder costs nothing until it changes.
 */
import { FILE_NAME_EXT } from "@hivemind/core/opener";

/** A link found in a line: its text and where it starts (0-based, in characters). */
export interface FoundLink { text: string; start: number }

const TOKEN_RE = /(?:file:\/\/)?[\w.+@~/-]+(?::\d+(?::\d+)?)?/g;
const LINE_AT_END = /:\d+(?::\d+)?$/;

/** Paths in a line of terminal text: anything with a `/`, and a bare name when it has a line
 *  (`README.md:12`) or a file type the app opens (`package.json`). Web addresses are left to the
 *  web link finder. */
export function findPathLinks(line: string): FoundLink[] {
  const found: FoundLink[] = [];
  for (const m of line.matchAll(TOKEN_RE)) {
    const start = m.index ?? 0;
    const text = m[0].replace(/[.]+$/, "");
    const before = start > 0 ? line[start - 1] : "";
    if (before === ":" || text.length < 3) continue;
    if (/^[a-z][a-z0-9+.-]*$/i.test(text) && line.startsWith("://", start + text.length)) continue;
    const name = text.replace(LINE_AT_END, "");
    const ext = /\.([A-Za-z][\w]{0,9})$/.exec(name)?.[0]?.toLowerCase();
    const slash = name.includes("/") && /[\w~]/.test(name.replace(/^file:\/\//, ""));
    const named = !!ext && /[\w-]\.[A-Za-z]/.test(name) && (LINE_AT_END.test(text) || FILE_NAME_EXT.has(ext));
    if (slash || named) found.push({ text, start });
  }
  return found;
}

/** A line of a terminal as the link finder reads it; `wrapped`: the terminal itself wrapped the
 *  line above into this one. */
export interface TermLine { text: string; wrapped: boolean }

/** A path link that may run on from one line into the next: where it starts and ends (0-based
 *  columns, `to` past its last) on this line (`dy` 0), the one above (-1) or the one below (1).
 *  `part`: the link on this line alone, opened when nothing is at `text`. */
export interface LineLink { text: string; from: { dy: -1 | 0; x: number }; to: { dy: 0 | 1; x: number }; part?: string }

/** How near the terminal's width a line must end to run on: an agent wraps its own lines a little short of it. */
const RUN_ON_MARGIN = 6;
const COMMON_WIDTHS = new Set([80]);

/** Whether `line` runs on into `next`: the terminal wrapped it, or, when `guess`, it ends at (or near) the width. */
function runsOn(line: TermLine, next: TermLine, cols: number, guess: boolean): boolean {
  if (next.wrapped) return true;
  if (!guess) return false;
  const end = line.text.trimEnd().length;
  return end >= cols - RUN_ON_MARGIN || COMMON_WIDTHS.has(end);
}

/** The path characters that end `text`, blanks aside. */
function endPart(text: string): { text: string; start: number } | null {
  const end = text.trimEnd().length;
  let last: RegExpMatchArray | null = null;
  for (const m of text.matchAll(TOKEN_RE)) last = m;
  const start = last?.index ?? -1;
  if (!last || start + last[0].length !== end || text[start - 1] === ":") return null;
  return { text: last[0], start };
}

/** The path characters that start `line`, after its indent unless the terminal wrapped it. */
function startPart(line: TermLine): { text: string; start: number } | null {
  const start = line.wrapped ? 0 : line.text.length - line.text.trimStart().length;
  const m = new RegExp(TOKEN_RE.source, "y");
  m.lastIndex = start;
  const found = m.exec(line.text);
  return found && /\w/.test(found[0]) ? { text: found[0], start } : null;
}

/** The path `upper` and `lower` make together, when it runs into `lower`: a line an agent broke
 *  itself only after a `/`, so prose that fills a line does not join its next word. */
function joined(upper: string, lower: string, wrapped: boolean): string | null {
  if (!wrapped && !upper.includes("/")) return null;
  const link = findPathLinks(upper + lower)[0];
  return link && link.start === 0 && link.text.length > upper.length ? link.text : null;
}

/** Paths on `here`, each joined with the line above or below when it runs on into it: what a click
 *  on either part opens, its underline over both. Reads only these three lines. `guess`: a line that
 *  only ends near the width joins too, for a caller that checks the joined path is there. */
export function pathLinksOn(here: TermLine, above: TermLine | null, below: TermLine | null, cols: number, guess: boolean): LineLink[] {
  const single = findPathLinks(here.text);
  const links: LineLink[] = [];
  const up = above && runsOn(above, here, cols, guess) ? endPart(above.text) : null;
  const first = up && startPart(here);
  const upText = up && first ? joined(up.text, first.text, here.wrapped) : null;
  const down = below && runsOn(here, below, cols, guess) ? endPart(here.text) : null;
  const next = down && startPart(below!);
  const downText = down && next ? joined(down.text, next.text, below!.wrapped) : null;
  for (const l of single) {
    if (upText && l.start === first!.start) continue;
    if (downText && l.start === down!.start) continue;
    links.push({ text: l.text, from: { dy: 0, x: l.start }, to: { dy: 0, x: l.start + l.text.length } });
  }
  const partAt = (start: number) => single.find((l) => l.start === start)?.text;
  if (upText) links.push({ text: upText, from: { dy: -1, x: up!.start }, to: { dy: 0, x: first!.start + upText.length - up!.text.length }, ...part(partAt(first!.start)) });
  if (downText) links.push({ text: downText, from: { dy: 0, x: down!.start }, to: { dy: 1, x: next!.start + downText.length - down!.text.length }, ...part(partAt(down!.start)) });
  return links;
}

const part = (text: string | undefined): { part?: string } => (text ? { part: text } : {});

/** The folder a shell says it is in (OSC 7, OSC 633;P;Cwd=, OSC 1337;CurrentDir=), from the
 *  sequence's number and what follows it; null when it says something else. */
export function shellFolderOf(code: 7 | 633 | 1337, data: string): string | null {
  if (code === 7) {
    if (!/^file:\/\//i.test(data)) return null;
    try { return clean(decodeURIComponent(new URL(data).pathname)); } catch { return null; }
  }
  if (code === 633) {
    const m = /^P;Cwd=(.*)$/s.exec(data);
    return m ? clean(m[1]!.replace(/\\x([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))).replace(/\\\\/g, "\\")) : null;
  }
  const m = /^CurrentDir=(.*)$/s.exec(data);
  return m ? clean(m[1]!) : null;
}

/** Whether an OSC 7 names another computer than `here` (this one's host name): a shell reached over
 *  ssh inside a local terminal, whose paths are not this computer's. */
export function namesAnotherComputer(data: string, here: string | null): boolean {
  let host = "";
  try { host = new URL(data).hostname.toLowerCase(); } catch { return false; }
  if (!host || host === "localhost" || !here) return false;
  return !sameComputer(host, here);
}

/** Whether two host names are one computer: the same full name, or one given only by its first part. */
function sameComputer(a: string, b: string): boolean {
  const x = a.toLowerCase(), y = b.toLowerCase();
  if (x === y) return true;
  return (!x.includes(".") || !y.includes(".")) && x.split(".")[0] === y.split(".")[0];
}

/** A terminal's title (OSC 0/2) that says its shell is on another computer: a running `ssh` or
 *  `mosh`, or the `user@host` prompt title of a host that is not `here`. A guess: a title can say anything. */
export function titleNamesAnotherComputer(title: string, here: string | null): boolean {
  if (/^(?:ssh|mosh|autossh|et)(?:\s|$)/.test(title.trim())) return true;
  const host = /^[\w.-]+@([A-Za-z0-9][\w.-]*?)(?::|\s|$)/.exec(title.trim())?.[1];
  return !!host && !!here && host.toLowerCase() !== "localhost" && !sameComputer(host, here);
}

const clean = (p: string): string | null => (p && !p.includes("\0") ? p : null);

/** The folder a shell's path names, for a tile whose folder is `base`: on another machine the
 *  shell's paths are that machine's. */
export function folderFor(base: string, shellPath: string): string {
  const remote = /^([a-z][a-z0-9+.-]*:\/\/[^/]*)/i.exec(base);
  return remote && !/^[a-z]:[\\/]/i.test(base) ? `${remote[1]}${shellPath.startsWith("/") ? "" : "/"}${shellPath}` : shellPath;
}

const WEB_RE = /https?:\/\/[^\s<>"'`]+/g;

/** Every web address and path on the screen's lines (`y` 1-based in the buffer, top first), the
 *  newest first, each once: what the "Open detected link" picker lists. */
export function linksOnScreen(lines: ReadonlyArray<{ y: number; text: string }>): Array<{ text: string; y: number }> {
  const seen = new Set<string>();
  const found: Array<{ text: string; y: number }> = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const { y, text } = lines[i]!;
    const here = [...text.matchAll(WEB_RE)].map((m) => ({ text: m[0].replace(/[).,;:'"\]]+$/, ""), at: m.index ?? 0 }))
      .concat(findPathLinks(text).map((l) => ({ text: l.text, at: l.start })))
      .sort((a, b) => b.at - a.at);
    for (const l of here) if (!seen.has(l.text)) { seen.add(l.text); found.push({ text: l.text, y }); }
  }
  return found;
}

/** Whether a path clicked in a terminal titled `title`, whose folder here is `folder`, is likely the
 *  other computer's: its shell is over ssh by the title, and the path is absolute (or from home) and
 *  outside that folder, so the same path here is some other file. */
export function clickedPathElsewhere(thing: string, title: string, here: string | null, folder: string): boolean {
  if (!titleNamesAnotherComputer(title, here)) return false;
  const path = thing.replace(/^file:\/\/(?:localhost)?/i, "");
  if (!/^(?:\/|~\/|[a-z]:[\\/])/i.test(path)) return false;
  const base = folder.replace(/[\\/]+$/, "");
  return !(path === base || path.startsWith(`${base}/`));
}
