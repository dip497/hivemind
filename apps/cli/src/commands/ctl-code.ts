/**
 * `hive ctl code outline|definition|usages|hover <file>[:line[:col]]`: the answers the Code tile
 * gets (workspace API `code.*`, 0.43), for agents. Lines and columns count from 1 here, as
 * compilers print them, in what is asked and in what is printed; each `at` is ready for
 * `hive ctl open`. Every answer says how sure it is: `syntax`, `index` or `compiler`.
 */
import path from "node:path";
import { defineCommand, type ArgsDef } from "citty";
import type { Answer, CodeLocation, CodeSymbol, Hover } from "@hivemind/code-intel/contract";
import type { Drive } from "../drive.js";
import { UsageError } from "../ctl-args.js";

/** What ctl.ts lends every verb. */
export interface CtlParts {
  sub: typeof import("./ctl.js").sub;
  onDrive<T>(use: (d: Drive) => Promise<T>): Promise<T>;
  workspaceOf(d: Drive, repo: unknown): Promise<string>;
  repoArg: ArgsDef;
}

/** The host waits 20 s for a language server; this waits a little longer for the host. */
const CALL_MS = 40_000;
const PLACE = /^(.*?)(?::(\d+))?(?::(\d+))?$/;

/** `path[:line[:col]]`, relative to this folder or absolute, as the workspace sees it. */
export function placeOf(written: string, repo: string, needsLine: boolean): { file: string; at?: { line: number; col: number } } {
  const [, file = "", line, col] = PLACE.exec(written) ?? [];
  if (!file) throw new UsageError(`"${written}" is not a file`);
  if (needsLine && !line) throw new UsageError(`say where in the file: ${file}:<line>[:<column>], counting from 1`);
  const rel = path.relative(repo, path.resolve(file));
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new UsageError(`${file} is not inside the workspace ${repo}`);
  return { file: rel.split(path.sep).join("/"), ...(line ? { at: { line: Number(line), col: Math.max(0, Number(col ?? 1) - 1) } } : {}) };
}

const placeText = (l: CodeLocation) => ({
  at: `${l.file}:${l.span.start.line}:${l.span.start.col + 1}`,
  file: l.file, line: l.span.start.line, col: l.span.start.col + 1, ...(l.text !== undefined ? { text: l.text.trim() } : {}),
});
const symbolText = (s: CodeSymbol): unknown => ({
  name: s.name, kind: s.kind, line: s.nameAt.line, col: s.nameAt.col + 1, endLine: s.span.end.line,
  ...(s.children.length ? { children: s.children.map(symbolText) } : {}),
});
const sureness = (a: Answer | null) => ({ accuracy: a?.accuracy ?? null, by: a?.by ?? null, ...(a?.partial ? { partial: a.partial } : {}) });
/** A partial compiler answer's text places, kept beside it. */
const alsoOf = (a: Answer | null) => (a?.also ? { also: { accuracy: a.also.accuracy, by: a.also.by, places: a.also.value.map(placeText) } } : {});

export function codeCommand(c: CtlParts) {
  const fileArg = { place: { type: "positional", required: true, description: "the file, path[:line[:col]] from 1, relative to here" } } as const;
  const ask = (method: string, needsLine: boolean) => (a: { place: unknown; repo?: unknown }) => c.onDrive(async (d) => {
    const repo = await c.workspaceOf(d, a.repo);
    const { file, at } = placeOf(String(a.place), repo, needsLine);
    return d.call(method, at ? [repo, file, at] : [repo, file], CALL_MS) as Promise<Answer | null>;
  });
  return defineCommand({
    meta: { name: "code", description: "Ask about code as the Code tile does: a file's outline, where a symbol is defined, its usages, its type. Each answer says how sure it is (syntax, index or compiler)" },
    subCommands: {
      outline: c.sub("outline", "A file's classes, functions and their members, with where each is: { accuracy, by, symbols: [{ name, kind, line, col, endLine, children? }] }",
        { ...fileArg, ...c.repoArg }, async (a) => {
          const r = await ask("code.outline", false)(a);
          return { ...sureness(r), symbols: ((r?.value ?? []) as CodeSymbol[]).map(symbolText) };
        }),
      definition: c.sub("definition", "Where the symbol at file:line:col is defined: { accuracy, by, places: [{ at, file, line, col, text }] }. Without a language server for it, from the file's own outline (accuracy syntax)",
        { ...fileArg, ...c.repoArg }, async (a) => {
          const r = await ask("code.definition", true)(a);
          return { ...sureness(r), places: ((r?.value ?? []) as CodeLocation[]).map(placeText) };
        }),
      usages: c.sub("usages", "Every usage of the symbol at file:line:col, its definition included: { accuracy, by, places: [{ at, file, line, col, text }] }. Without a language server for it, every place the word is written (accuracy syntax). When the server looked at part of the workspace, `partial` says which, and `also` lists the places the text search found that it did not",
        { ...fileArg, ...c.repoArg }, async (a) => {
          const r = await ask("code.usages", true)(a);
          return { ...sureness(r), places: ((r?.value ?? []) as CodeLocation[]).map(placeText), ...alsoOf(r) };
        }),
      hover: c.sub("hover", "What the language server says of the symbol at file:line:col, its type and its doc comment, as markdown: { accuracy, by, text }",
        { ...fileArg, ...c.repoArg }, async (a) => {
          const r = await ask("code.hover", true)(a);
          return { ...sureness(r), text: (r?.value as Hover | null)?.text ?? null };
        }),
    },
  });
}
