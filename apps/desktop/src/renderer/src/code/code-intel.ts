/**
 * The Code tile's code intelligence: outline and folds from tree-sitter in a Worker, on the text
 * being edited; definition, usages and hover from the workspace's host (its language servers,
 * else syntax), which says how sure each answer is. An answer about a version of the file the
 * editor has moved on from is dropped, so a slow answer never lands on newer text.
 */
import { CodeAnswers } from "@hivemind/code-intel/answers";
import { languageOf, type Answer, type CodeDocument, type CodeIntelProvider, type LanguageId, type Place } from "@hivemind/code-intel/contract";
import { isRemote } from "@hivemind/core/remote-uri";
import { outsideOf } from "../code-files";
import type { SyntaxAsk, SyntaxReply } from "./syntax.worker";

/** A Worker idle this long is let go; the next question starts another. */
const WORKER_IDLE_MS = 10 * 60_000;

let worker: Worker | null = null;
let idle: ReturnType<typeof setTimeout> | undefined;
let nextReq = 1;
const waiting = new Map<number, (r: SyntaxReply) => void>();

function syntaxWorker(): Worker {
  clearTimeout(idle);
  idle = setTimeout(() => { if (waiting.size === 0) { worker?.terminate(); worker = null; } }, WORKER_IDLE_MS);
  if (worker) return worker;
  const w = new Worker(new URL("./syntax.worker.ts", import.meta.url), { type: "module" });
  w.onmessage = (e: MessageEvent<SyntaxReply>) => { const done = waiting.get(e.data.req); waiting.delete(e.data.req); done?.(e.data); };
  w.onerror = () => { for (const [req, done] of waiting) done({ req, error: "the syntax worker failed" }); waiting.clear(); worker = null; };
  worker = w;
  return w;
}

function readSyntax(language: LanguageId, text: string): Promise<SyntaxReply> {
  const req = nextReq++;
  return new Promise((resolve) => {
    waiting.set(req, resolve);
    syntaxWorker().postMessage({ req, language, text } satisfies SyntaxAsk);
  });
}

const syntaxProvider: CodeIntelProvider = {
  id: "tree-sitter", languages: ["typescript", "tsx", "javascript", "python", "rust", "go", "java"], runs: "worker", accuracy: "syntax",
  answers: ["documentSymbol", "foldingRange"],
  async ask(question, doc) {
    if (doc.text === undefined) return null;
    const r = await readSyntax(doc.language, doc.text);
    if ("error" in r) throw new Error(r.error);
    return { value: (question === "documentSymbol" ? r.outline : r.folding) as never };
  },
};

const answers = new CodeAnswers(() => [syntaxProvider]);

/** The file being edited, as a question is asked about it. */
export interface EditedFile {
  repo: string;
  /** Relative to the repo. */
  file: string;
  text: string;
  version: number;
  /** The text differs from the file on disk: the host is sent it, else it reads the file. */
  unsaved?: boolean;
}

const documentOf = (f: EditedFile): CodeDocument | null => {
  const language = languageOf(f.file);
  return language ? { file: `${f.repo}/${f.file}`, language, version: f.version, text: f.text } : null;
};

export const codeIntel = {
  /** Whether questions can be asked about this file at all. */
  knows: (file: string): boolean => languageOf(file) !== null,
  /** The editor's text changed: answers about older versions are dropped from now on. */
  edited(f: Pick<EditedFile, "repo" | "file" | "version">): void { answers.edited(`${f.repo}/${f.file}`, f.version); },
  closed(f: Pick<EditedFile, "repo" | "file">): void { answers.closed(`${f.repo}/${f.file}`); },

  outline(f: EditedFile): Promise<Answer<"documentSymbol"> | null> {
    const doc = documentOf(f);
    return doc ? answers.ask("documentSymbol", doc) : Promise.resolve(null);
  },
  folding(f: EditedFile): Promise<Answer<"foldingRange"> | null> {
    const doc = documentOf(f);
    return doc ? answers.ask("foldingRange", doc) : Promise.resolve(null);
  },

  /** Each question to the host gives its fastest answer to `onAnswer` first, then a more accurate
   *  one as it comes; the promise is the last. `cancel()` (the cursor moved) takes it back. */
  definition: (f: EditedFile, at: Place, onAnswer?: (a: Answer<"definition">) => void) =>
    fromHost(f, onAnswer, (opts) => window.hive.codeDefinition(f.repo, f.file, at, opts)),
  usages: (f: EditedFile, at: Place, onAnswer?: (a: Answer<"references">) => void) =>
    fromHost(f, onAnswer, (opts) => window.hive.codeUsages(f.repo, f.file, at, opts)),
  hover: (f: EditedFile, at: Place, onAnswer?: (a: Answer<"hover">) => void) =>
    fromHost(f, onAnswer, (opts) => window.hive.codeHover(f.repo, f.file, at, opts)),
};

/** A question to the host: its last answer, and how to take it back. */
export interface Asked<A> { answer: Promise<A | null>; cancel(): void }

let nextAsk = 1;
/** The host's early answers, to the question each belongs to: one listener for the window. */
const early = new Map<number, (a: Answer) => void>();
let listening: (() => void) | null = null;

function fromHost<A extends Answer>(f: EditedFile, onAnswer: ((a: A) => void) | undefined, call: (opts: { version: number; ask: number; text?: string }) => Promise<A | null>): Asked<A> {
  const file = `${f.repo}/${f.file}`;
  if (!languageOf(f.file)) return { answer: Promise.resolve(null), cancel: () => {} };
  // The host answers about its own workspace's files only.
  if (isRemote(f.repo) || outsideOf(f.repo, f.file)) return { answer: Promise.reject(new Error("Code questions work inside the workspace")), cancel: () => {} };
  answers.edited(file, f.version);
  const ask = nextAsk++;
  let cancelled = false;
  const fresh = (a: A | null) => !cancelled && !!a && answers.current(file, a.version);
  listening ??= window.hive.onCodeAnswered((id, a) => early.get(id)?.(a));
  if (onAnswer) early.set(ask, (a) => { if (fresh(a as A)) onAnswer(a as A); });
  const answer = call({ version: f.version, ask, ...(f.unsaved ? { text: f.text } : {}) })
    .then((a) => (fresh(a) ? a : null))
    .finally(() => early.delete(ask));
  return {
    answer,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      early.delete(ask);
      window.hive.codeCancel(ask);
    },
  };
}
