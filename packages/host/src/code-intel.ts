/**
 * Questions about code on a workspace's host (0.43): outline, definition, usages and hover. The
 * sidecar answers from tree-sitter and the language servers; when no server answers, usages come
 * from a text search for the word and a definition from the file's own outline, both at syntax
 * accuracy. Every answer says how sure it is. Electron-free: the app and `hive host` each say
 * how the sidecar starts (`setCodeSidecar`).
 */
import fs from "node:fs/promises";
import { CodeAnswers } from "@hivemind/code-intel/answers";
import { languageOf, type Answer, type CodeDocument, type CodeIntelProvider, type CodeLocation, type CodeSymbol, type LanguageId, type Place, type Question, type Reply } from "@hivemind/code-intel/contract";
import { launchBeside, SidecarClient, type SidecarLaunch } from "@hivemind/code-intel/sidecar-client";
import type { SidecarQuestion } from "@hivemind/code-intel/sidecar";
import { isRemote } from "@hivemind/core/remote-uri";
import { ApiError, fields, text, whole } from "@hivemind/workspace-api/protocol";
import { emit, type Connection, type Domain } from "@hivemind/workspace-api/server";
import { grep } from "./code-search.js";
import { LARGEST_TEXT_FILE } from "./files.js";
import { resolveInRepo, resolveRealInRepo } from "./repo-paths.js";

const LANGUAGES: LanguageId[] = ["typescript", "tsx", "javascript", "python", "rust", "go", "java"];
/** How long a question waits for the language server before the best answer so far is given. */
const WAIT_MS = 20_000;
/** The most editor text a question may carry. */
const TEXT_MAX = 8 * 1024 * 1024;

let launch: () => SidecarLaunch = launchBeside;
let sidecar: SidecarClient | null = null;
/** How this host starts the sidecar where it is not built beside this code (a compiled `hive`). */
export function setCodeSidecar(how: () => SidecarLaunch): void { launch = how; }
const side = (): SidecarClient => (sidecar ??= new SidecarClient(() => launch()));

/** The sidecar process, to measure (the machine usage widget) and to close with the host. */
export const codeSidecar = { pid: (): number | null => sidecar?.pid ?? null, close: (): void => sidecar?.close() };

async function ofSidecar(question: SidecarQuestion, repo: string, doc: CodeDocument, at?: Place): Promise<Reply<never> | null> {
  const r = await side().ask({ question, root: repo, file: doc.file, language: doc.language, ...(at ? { at } : {}), ...(doc.text !== undefined ? { text: doc.text } : {}) }, WAIT_MS + 5_000);
  if ("error" in r) throw new Error(r.error);
  return "answer" in r && r.answer != null ? { value: r.answer as never, ...(r.partial ? { partial: r.partial } : {}) } : null;
}

const WORD = /[\p{L}\p{N}_$]/u;
/** The identifier under `at` in the file, or null on a space or a sign. */
async function wordAt(doc: CodeDocument, at: Place): Promise<string | null> {
  const line = (doc.text ?? await fs.readFile(doc.file, "utf8")).split("\n")[at.line - 1] ?? "";
  let start = at.col;
  let end = at.col;
  while (start > 0 && WORD.test(line[start - 1]!)) start--;
  while (end < line.length && WORD.test(line[end]!)) end++;
  return end > start ? line.slice(start, end) : null;
}

/** Usages by text: lines holding the word as a whole word (the first page of the search). */
async function usagesByWord(repo: string, doc: CodeDocument, at: Place): Promise<Reply<"references"> | null> {
  const word = await wordAt(doc, at);
  if (!word) return null;
  const page = await grep(repo, word, { mode: "plain", caseSensitive: true });
  const found: CodeLocation[] = [];
  for (const l of page.lines) {
    for (const [s, e] of l.ranges) {
      if ((s > 0 && WORD.test(l.text[s - 1]!)) || (e < l.text.length && WORD.test(l.text[e]!))) continue;
      found.push({ file: l.path, span: { start: { line: l.line, col: s }, end: { line: l.line, col: e } }, text: l.text });
    }
  }
  return { value: found };
}

/** A definition by name in the file's own outline. */
async function definitionInOutline(repo: string, doc: CodeDocument, at: Place): Promise<Reply<"definition"> | null> {
  const word = await wordAt(doc, at);
  if (!word) return null;
  const outline = (await ofSidecar("documentSymbol", repo, doc))?.value as CodeSymbol[] | undefined;
  const found: CodeLocation[] = [];
  const walk = (symbols: CodeSymbol[]) => { for (const s of symbols) { if (s.name === word) found.push({ file: relativeIn(repo, doc.file), span: { start: s.nameAt, end: { line: s.nameAt.line, col: s.nameAt.col + word.length } } }); walk(s.children); } };
  walk(outline ?? []);
  return { value: found };
}

const relativeIn = (repo: string, file: string): string => file.startsWith(repo + "/") ? file.slice(repo.length + 1) : file;

/** Who may make this machine start a language server (a program from the workspace or PATH): the
 *  person, their own devices and the agents and programs on this machine. A guest gets the
 *  syntax and text answers, which run only the app's own code. */
const mayStartServers = (from: Connection): boolean =>
  from.actor.kind !== "peer" || from.actor.access === "owner" || !!from.actor.client;

const providersByRepo = new Map<string, { all: CodeIntelProvider[]; guest: CodeIntelProvider[] }>();
function providersFor(repo: string, from: Connection): CodeIntelProvider[] {
  let had = providersByRepo.get(repo);
  if (!had) {
    const sidecarProvider = (id: string, accuracy: "syntax" | "compiler", answers: SidecarQuestion[]): CodeIntelProvider => ({
      id, languages: LANGUAGES, runs: "sidecar", accuracy, answers,
      ask: (q, doc, at) => ofSidecar(q as SidecarQuestion, repo, doc, at),
    });
    const guest: CodeIntelProvider[] = [
      sidecarProvider("tree-sitter", "syntax", ["documentSymbol", "foldingRange"]),
      { id: "word-search", languages: LANGUAGES, runs: "sidecar", accuracy: "syntax", answers: ["references"], ask: (_q, doc, at) => usagesByWord(repo, doc, at!) as never },
      { id: "outline-name", languages: LANGUAGES, runs: "sidecar", accuracy: "syntax", answers: ["definition"], ask: (_q, doc, at) => definitionInOutline(repo, doc, at!) as never },
    ];
    had = { guest, all: [...guest, sidecarProvider("language-server", "compiler", ["definition", "references", "hover"])] };
    providersByRepo.set(repo, had);
  }
  return mayStartServers(from) ? had.all : had.guest;
}

const bad = (message: string): never => { throw new ApiError("BAD_REQUEST", message); };

/** The question's file, checked: inside the repo, on this machine, in a language known here. */
async function documentOf(repo: unknown, file: unknown, opts: unknown): Promise<{ repo: string; doc: CodeDocument }> {
  const r = text(repo, "repo");
  if (isRemote(r)) throw new ApiError("UNSUPPORTED", "code questions are answered on the machine that holds the files; ask its host");
  const abs = resolveInRepo(r, text(file, "file"));
  // A link inside the workspace to a file outside it is refused like the path itself would be.
  const real = await resolveRealInRepo(r, text(file, "file"));
  const language = languageOf(abs) ?? bad(`no code intelligence for ${text(file, "file")}: it knows TypeScript, JavaScript, Python, Rust, Go and Java`);
  const o = opts == null ? {} : fields(opts, "opts");
  if (o.text !== undefined && (typeof o.text !== "string" || o.text.length > TEXT_MAX)) bad(`opts.text must be text of at most ${TEXT_MAX} characters`);
  if (o.text === undefined) {
    const { size } = await fs.stat(real);
    if (size > LARGEST_TEXT_FILE) throw new ApiError("FILE_TOO_BIG", `${text(file, "file")} is ${(size / 1024 / 1024).toFixed(1)} MB: code questions read files of at most ${LARGEST_TEXT_FILE / 1024 / 1024} MB`);
  }
  const version = o.version === undefined ? 0 : whole(o.version, "opts.version");
  return { repo: r, doc: { file: abs, language, version, ...(typeof o.text === "string" ? { text: o.text } : {}) } };
}

function placeOf(v: unknown): Place {
  const p = fields(v, "at");
  return { line: whole(p.line, "at.line", 1), col: whole(p.col, "at.col") };
}

/** The questions each connection has asked with an `ask` id and not had answered, to take back. */
const open = new WeakMap<Connection, Map<number, AbortController>>();

async function ask<Q extends Question>(from: Connection, question: Q, repo: unknown, file: unknown, at: unknown, opts: unknown): Promise<Answer<Q> | null> {
  const o = opts == null ? {} : fields(opts, "opts");
  const id = o.ask === undefined ? null : whole(o.ask, "opts.ask");
  // Held before anything is awaited, so a `code.cancel` sent right after the call finds it.
  const taken = new AbortController();
  let mine = open.get(from);
  if (id !== null) { if (!mine) open.set(from, (mine = new Map())); mine.get(id)?.abort(); mine.set(id, taken); }
  try {
    const { repo: r, doc } = await documentOf(repo, file, opts);
    // Each caller counts its own versions, so one question's version says nothing of another's.
    return await new CodeAnswers(() => providersFor(r, from)).ask(question, doc, at === undefined ? undefined : placeOf(at), {
      within: WAIT_MS, signal: taken.signal,
      // With an id, each answer better than the last is sent as it comes; the reply is the last.
      ...(id !== null ? { onAnswer: (a: Answer<Q>) => emit(from, "code.answered", id, a as Answer) } : {}),
    });
  } finally {
    if (id !== null && mine?.get(id) === taken) mine.delete(id);
  }
}

export const codeIntel: Domain<"code.outline" | "code.definition" | "code.usages" | "code.hover", "code.cancel"> = {
  answers: {
    "code.outline": (from, repo, file, opts) => ask(from, "documentSymbol", repo, file, undefined, opts),
    "code.definition": (from, repo, file, at, opts) => ask(from, "definition", repo, file, at, opts),
    "code.usages": (from, repo, file, at, opts) => ask(from, "references", repo, file, at, opts),
    "code.hover": (from, repo, file, at, opts) => ask(from, "hover", repo, file, at, opts),
  },
  effects: {},
  notices: {
    // The cursor moved: the question with this id is answered null and told nothing more.
    "code.cancel": (from, id) => open.get(from)?.get(whole(id, "ask"))?.abort(),
  },
};
