/** Status detection as data: rules cross IPC where functions cannot, and no test can
 *  backtrack. There is no regex here for anyone, ours included — this runs on the poll
 *  thread, and a pattern that backtracks is one that can freeze the window. */
import type { TileStatus } from "./types.js";
import { cursorWordActive, hasBrailleSpinner, hasConfirmationPrompt, hasInterruptPattern } from "./detect-helpers.js";

export type Scope =
  | { kind: "screen" }
  /** after dropping trailing empty lines */
  | { kind: "tail"; n: number }
  | { kind: "tailNonEmpty"; n: number };

export type LineTest =
  | { contains: string }            // case-insensitive
  | { containsCS: string }          // case-sensitive
  | { startsWith: string }          // case-insensitive
  /** first char is one of these literals, or any braille glyph via "braille" */
  | { startsWithAny: string[] }
  /** strip a leading glyph run, then the first word ends in "-ing" (a spinner) */
  | { gerundAfterPrefix: string[] }
  /** strip a leading glyph run, then the next non-space char is a letter */
  | { letterAfterPrefix: string[] }
  /** the first number right before `word` on this line; case-insensitive */
  | { numBeforeWord: string; op: Cmp; value: number }
  | { anyOf: LineTest[] };

export type Expr =
  | { all: Expr[] }
  | { any: Expr[] }
  | { not: Expr }
  | { contains: string }            // case-insensitive, whole scope
  | { containsCS: string }          // case-sensitive, whole scope
  /** ALL tests hold for SOME single line (each line is trimStart'd first) */
  | { line: LineTest[] }
  | { helper: HelperName }
  /** a sequence of terms, matched on one line: anywhere in it, or from its very start */
  | { seq: Term[]; at?: "start"; ci?: boolean };

/**
 * One step of a `seq`. Between them these cover what agents actually print — a glyph, a
 * count, a bit of spacing, a word — without a regex engine behind them.
 *
 * A `run`'s set is a named one ("space", "digit", "word"), or the characters themselves;
 * a leading "!" negates it. Runs are greedy and the matcher never backtracks at all — each
 * term only moves forward — so the work one attempt can do is bounded by the line. Never
 * backtracking is also why an unbounded run must be followed by something its own set
 * cannot start: otherwise the run eats what the next term needed and the rule quietly never
 * matches. That is checked when the manifest loads rather than discovered in the terminal.
 */
export type Term =
  | { lit: string }
  /** the first of these that matches here wins, as a regex alternation would */
  | { any: string[] }
  | { run: string; min?: number; max?: number }
  /** everything up to and including the next `upTo`, within this line */
  | { upTo: string }
  /** zero-width: the next character, if there is one, is not in this set */
  | { notNext: string }
  /** zero-width: the line ends here */
  | { end: true };

export type Cmp = "gt" | "gte" | "lt" | "lte" | "eq";
export type HelperName = "hasBrailleSpinner" | "hasConfirmationPrompt" | "hasInterruptPattern";

export type Rule = { when: Expr; then: TileStatus; scope?: Scope };
export type DetectRules = { rules: Rule[]; default: TileStatus; scope?: Scope };

const isBraille = (c: string): boolean => c >= "⠀" && c <= "⣿";

const HELPERS: Record<HelperName, (s: string) => boolean> = {
  hasBrailleSpinner,
  hasConfirmationPrompt: (s) => hasConfirmationPrompt(s.toLowerCase()),
  hasInterruptPattern: (s) => hasInterruptPattern(s.toLowerCase()),
};

function sliceScope(screen: string, scope: Scope | undefined): string {
  if (!scope || scope.kind === "screen") return screen;
  const lines = screen.split("\n");
  if (scope.kind === "tail") {
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
    return lines.slice(-scope.n).join("\n");
  }
  return lines.reverse().filter((l) => l.trim() !== "").slice(0, scope.n).join("\n");
}

const reCache = new Map<string, RegExp>();
function rx(src: string, flags = ""): RegExp {
  const key = `${flags}\u0000${src}`;
  let r = reCache.get(key);
  if (!r) { r = new RegExp(src, flags); reCache.set(key, r); }
  return r;
}

function stripPrefix(line: string, glyphs: readonly string[]): string | null {
  const first = line.charAt(0);
  if (!first) return null;
  if (glyphs.includes("braille") && isBraille(first)) {
    let i = 0;
    while (i < line.length && isBraille(line[i]!)) i++;
    return line.slice(i);
  }
  return glyphs.includes(first) ? line.slice(1) : null;
}

function lineTest(t: LineTest, line: string): boolean {
  if ("anyOf" in t) return t.anyOf.some((x) => lineTest(x, line));
  if ("numBeforeWord" in t) return numBeforeWord(line.toLowerCase(), t.numBeforeWord.toLowerCase(), t.op, t.value);
  if ("contains" in t) return line.toLowerCase().includes(t.contains.toLowerCase());
  if ("containsCS" in t) return line.includes(t.containsCS);
  if ("startsWith" in t) return line.toLowerCase().startsWith(t.startsWith.toLowerCase());
  if ("startsWithAny" in t) {
    const f = line.charAt(0);
    return t.startsWithAny.some((g) => (g === "braille" ? isBraille(f) : f === g));
  }
  const glyphs = "gerundAfterPrefix" in t ? t.gerundAfterPrefix : t.letterAfterPrefix;
  const rest = stripPrefix(line, glyphs);
  if (rest === null) return false;
  if ("letterAfterPrefix" in t) {
    const c = rest.trimStart().charAt(0);
    return c !== "" && c.toLowerCase() !== c.toUpperCase();
  }
  return cursorWordActive(rest);
}

const SETS: Readonly<Record<string, (c: string) => boolean>> = {
  space: (c) => c === " " || c === "\t" || c === "\r" || c === " " || c === "\f" || c === "\v",
  digit: (c) => c >= "0" && c <= "9",
  word: (c) => (c >= "0" && c <= "9") || (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_",
};

function inSet(set: string, c: string): boolean {
  const neg = set.charAt(0) === "!";
  const name = neg ? set.slice(1) : set;
  const has = SETS[name] ? SETS[name]!(c) : name.includes(c);
  return neg ? !has : has;
}

/** What a term can begin with: either a set expression, or the literal characters. */
function firstChars(t: Term): { set?: string; chars: string; zeroWidth: boolean } {
  if ("lit" in t) return { chars: t.lit.charAt(0), zeroWidth: t.lit === "" };
  if ("any" in t) return { chars: t.any.map((a) => a.charAt(0)).join(""), zeroWidth: t.any.some((a) => a === "") };
  if ("run" in t) return { set: t.run, chars: "", zeroWidth: (t.min ?? 1) === 0 };
  return { chars: "", zeroWidth: true }; // notNext and end consume nothing
}

/**
 * Can one character satisfy both sets? Named classes and negation make this a question
 * about sets rather than about characters, so it is answered by probing: one representative
 * of each class, every character either set names, and one character in neither.
 */
function setsOverlap(a: string, b: string): string | null {
  const probes = new Set([" ", "\t", "\n", "0", "a", "Z", "_", "", ...a.replace(/^!/, ""), ...b.replace(/^!/, "")]);
  for (const c of probes) if (inSet(a, c) && inSet(b, c)) return c;
  return null;
}

/** One line, one match attempt starting at `i`. Returns the end index, or -1. */
function matchSeq(terms: readonly Term[], line: string, from: number): number {
  let i = from;
  for (const t of terms) {
    if ("lit" in t) {
      if (!line.startsWith(t.lit, i)) return -1;
      i += t.lit.length;
    } else if ("any" in t) {
      const hit = t.any.find((a) => line.startsWith(a, i));
      if (hit === undefined) return -1;
      i += hit.length;
    } else if ("run" in t) {
      const min = t.min ?? 1;
      const max = t.max ?? Infinity;
      let n = 0;
      while (n < max && i + n < line.length && inSet(t.run, line[i + n]!)) n++;
      if (n < min) return -1;
      i += n;
    } else if ("upTo" in t) {
      const at = line.indexOf(t.upTo, i);
      if (at === -1) return -1;
      i = at + t.upTo.length;
    } else if ("end" in t) {
      if (i < line.length) return -1;
    } else {
      if (i < line.length && inSet(t.notNext, line[i]!)) return -1;
    }
  }
  return i;
}

function seqMatches(e: { seq: Term[]; at?: "start"; ci?: boolean }, text: string): boolean {
  const hay = e.ci ? text.toLowerCase() : text;
  // A sequence that opens with a literal can only start where that literal is, which is the
  // difference between one pass over the line and one attempt per character of it.
  const first = e.seq[0];
  const anchor = first && "lit" in first ? first.lit : null;
  for (const line of hay.split("\n")) {
    if (e.at === "start") {
      if (matchSeq(e.seq, line, 0) !== -1) return true;
      continue;
    }
    if (anchor !== null) {
      for (let i = line.indexOf(anchor); i !== -1; i = line.indexOf(anchor, i + 1)) {
        if (matchSeq(e.seq, line, i) !== -1) return true;
      }
      continue;
    }
    for (let i = 0; i <= line.length; i++) if (matchSeq(e.seq, line, i) !== -1) return true;
  }
  return false;
}

function compare(n: number, op: Cmp, value: number): boolean {
  switch (op) {
    case "gt": return n > value;
    case "gte": return n >= value;
    case "lt": return n < value;
    case "lte": return n <= value;
    default: return n === value;
  }
}

/** `/(\d+)\s+<word>/` first match, without a regex engine. */
function numBeforeWord(text: string, word: string, op: Cmp, value: number): boolean {
  for (let i = text.indexOf(word); i !== -1; i = text.indexOf(word, i + 1)) {
    let j = i - 1;
    if (j < 0 || !/\s/.test(text[j]!)) continue;
    while (j >= 0 && /\s/.test(text[j]!)) j--;
    const end = j + 1;
    while (j >= 0 && text[j]! >= "0" && text[j]! <= "9") j--;
    if (end === j + 1) continue;
    return compare(Number(text.slice(j + 1, end)), op, value);
  }
  return false;
}

const CMPS: readonly Cmp[] = ["gt", "gte", "lt", "lte", "eq"];
const HELPER_NAMES: readonly HelperName[] = ["hasBrailleSpinner", "hasConfirmationPrompt", "hasInterruptPattern"];

function bad(msg: string): never { throw new Error(msg); }
const strArray = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === "string");

function validateLineTest(t: unknown, at: string): void {
  if (!t || typeof t !== "object") bad(`${at} must be an object`);
  const o = t as Record<string, unknown>;
  if ("anyOf" in o) {
    if (!Array.isArray(o.anyOf)) bad(`${at}.anyOf must be an array`);
    o.anyOf.forEach((x, i) => validateLineTest(x, `${at}.anyOf[${i}]`));
    return;
  }
  if ("contains" in o || "containsCS" in o || "startsWith" in o) {
    const k = "contains" in o ? "contains" : "containsCS" in o ? "containsCS" : "startsWith";
    if (typeof o[k] !== "string") bad(`${at}.${k} must be a string`);
    return;
  }
  for (const k of ["startsWithAny", "gerundAfterPrefix", "letterAfterPrefix"]) {
    if (k in o) {
      if (!strArray(o[k])) bad(`${at}.${k} must be a string array`);
      // Matched against one character: a longer entry would silently never match.
      for (const g of o[k] as string[]) {
        if (g !== "braille" && [...g].length !== 1) {
          bad(`${at}.${k}: "${g}" must be a single character or the token "braille"`);
        }
      }
      return;
    }
  }
  if ("numBeforeWord" in o) {
    if (typeof o.numBeforeWord !== "string") bad(`${at}.numBeforeWord must be a string`);
    if (!CMPS.includes(o.op as Cmp)) bad(`${at}.op must be one of ${CMPS.join(", ")}`);
    if (typeof o.value !== "number") bad(`${at}.value must be a number`);
    return;
  }
  bad(`${at}: unknown line test ${JSON.stringify(Object.keys(o))}`);
}

/**
 * A sequence anyone may ship: a bounded number of terms, each of a known shape, and no
 * unbounded run that would swallow what the term after it has to match.
 */
function validateSeq(o: Record<string, unknown>, at: string): void {
  if (!Array.isArray(o.seq) || o.seq.length === 0 || o.seq.length > 12) bad(`${at}.seq must be 1-12 terms`);
  if (o.at !== undefined && o.at !== "start") bad(`${at}.at must be "start"`);
  if (o.ci !== undefined && typeof o.ci !== "boolean") bad(`${at}.ci must be true or false`);
  const terms = o.seq as Record<string, unknown>[];
  terms.forEach((t, i) => {
    const where = `${at}.seq[${i}]`;
    if (!t || typeof t !== "object") bad(`${where} must be an object`);
    const keys = ["lit", "any", "run", "upTo", "notNext", "end"].filter((k) => k in t);
    if (keys.length !== 1) bad(`${where} must have exactly one of lit, any, run, upTo, notNext, end`);
    if ("any" in t) {
      if (!strArray(t.any) || (t.any as string[]).length === 0 || (t.any as string[]).length > 8) bad(`${where}.any must be 1-8 strings`);
    } else if ("end" in t) {
      if (t.end !== true) bad(`${where}.end must be true`);
    } else if (typeof t[keys[0]!] !== "string" || (t[keys[0]!] as string) === "") {
      bad(`${where}.${keys[0]} must be a non-empty string`);
    }
    if ("run" in t) {
      for (const k of ["min", "max"] as const) {
        if (t[k] !== undefined && (!Number.isInteger(t[k]) || (t[k] as number) < 0)) bad(`${where}.${k} must be a count`);
      }
      if ((t.min ?? 1) > (t.max ?? Infinity)) bad(`${where}.min is larger than its max`);
    }
    if (o.ci === true) {
      const lits = "any" in t ? (t.any as string[]) : typeof t[keys[0]!] === "string" ? [t[keys[0]!] as string] : [];
      for (const s of lits) if (s !== s.toLowerCase()) bad(`${where}: with \`ci\` the text must be lower case ("${s}")`);
    }
  });
  // The no-backtracking rule, stated once: after an unbounded run, the next thing that can
  // consume a character must not start with one that run would have taken.
  terms.forEach((t, i) => {
    if (!("run" in t) || t.max !== undefined) return;
    for (const next of terms.slice(i + 1)) {
      if ("upTo" in next) bad(`${at}.seq[${i}]: an unbounded run cannot be followed by \`upTo\`, which takes anything`);
      const { set, chars, zeroWidth } = firstChars(next as Term);
      // A term that can match nothing cannot be starved by the run ahead of it; keep
      // looking for the first one that has to consume something.
      if (zeroWidth) continue;
      const clash = set !== undefined ? setsOverlap(t.run as string, set) : [...chars].find((c) => inSet(t.run as string, c));
      if (clash !== null && clash !== undefined) {
        bad(`${at}.seq[${i}]: an unbounded run of "${t.run}" cannot be followed by ${JSON.stringify(clash)} — it would have eaten it`);
      }
      return;
    }
  });
}

/** Unknown nodes are refused: a rule nobody can evaluate must not read as one that passed. */
export function validateExpr(e: unknown, at = "when"): void {
  if (!e || typeof e !== "object") bad(`${at} must be an object`);
  const o = e as Record<string, unknown>;
  for (const k of ["all", "any"] as const) {
    if (k in o) {
      if (!Array.isArray(o[k]) || (o[k] as unknown[]).length === 0) bad(`${at}.${k} must be a non-empty array`);
      (o[k] as unknown[]).forEach((x, i) => validateExpr(x, `${at}.${k}[${i}]`));
      return;
    }
  }
  if ("not" in o) { validateExpr(o.not, `${at}.not`); return; }
  if ("contains" in o || "containsCS" in o) {
    const k = "contains" in o ? "contains" : "containsCS";
    if (typeof o[k] !== "string") bad(`${at}.${k} must be a string`);
    return;
  }
  if ("line" in o) {
    if (!Array.isArray(o.line) || o.line.length === 0) bad(`${at}.line must be a non-empty array`);
    (o.line as unknown[]).forEach((t, i) => validateLineTest(t, `${at}.line[${i}]`));
    return;
  }
  if ("helper" in o) {
    if (!HELPER_NAMES.includes(o.helper as HelperName)) bad(`${at}.helper must be one of ${HELPER_NAMES.join(", ")}`);
    return;
  }
  if ("seq" in o) { validateSeq(o, at); return; }
  if ("re" in o) bad(`${at}.re: rules do not take regexes — use \`seq\`, which cannot backtrack`);
  bad(`${at}: unknown expression ${JSON.stringify(Object.keys(o))}`);
}

export function validateScope(s: unknown, at: string): void {
  if (s === undefined) return;
  if (!s || typeof s !== "object") bad(`${at} must be an object`);
  const o = s as Record<string, unknown>;
  if (o.kind === "screen") return;
  if (o.kind === "tail" || o.kind === "tailNonEmpty") {
    if (typeof o.n !== "number" || !Number.isInteger(o.n) || o.n <= 0) bad(`${at}.n must be a positive integer`);
    return;
  }
  bad(`${at}.kind must be screen, tail or tailNonEmpty`);
}

export function evalExpr(e: Expr, text: string): boolean {
  if ("all" in e) return e.all.every((x) => evalExpr(x, text));
  if ("any" in e) return e.any.some((x) => evalExpr(x, text));
  if ("not" in e) return !evalExpr(e.not, text);
  if ("contains" in e) return text.toLowerCase().includes(e.contains.toLowerCase());
  if ("containsCS" in e) return text.includes(e.containsCS);
  if ("line" in e) {
    return text.split("\n").some((l) => {
      const s = l.trimStart();
      return e.line.every((t) => lineTest(t, s));
    });
  }
  if ("helper" in e) return HELPERS[e.helper](text);
  return seqMatches(e, text);
}

export function compileDetect(d: DetectRules): (screen: string) => TileStatus {
  return (screen: string) => {
    for (const r of d.rules) {
      if (evalExpr(r.when, sliceScope(screen, r.scope ?? d.scope))) return r.then;
    }
    return d.default;
  };
}

