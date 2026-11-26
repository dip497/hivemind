/**
 * Code intelligence (docs/design/code-windows-links-2026-11-25.md, step 4): what a provider
 * answers, how sure it is, and for which version of the file. Positions are the workspace API's:
 * `line` 1-based, `col` 0-based in characters. No I/O here.
 */

/** How an answer was made, least to most sure: the file's syntax alone, a workspace index, or the
 *  language's own compiler through its language server. */
export type Accuracy = "syntax" | "index" | "compiler";
export const ACCURACY_RANK: Record<Accuracy, number> = { syntax: 0, index: 1, compiler: 2 };

/** What a provider can be asked. */
export type Question =
  | "documentSymbol"
  | "foldingRange"
  | "definition"
  | "references"
  | "hover"
  | "callHierarchy"
  | "rename"
  | "diagnostic"
  | "workspaceSymbol";

/** Questions that change files: answered only by a compiler-accurate provider. */
export const NEEDS_COMPILER: ReadonlySet<Question> = new Set<Question>(["rename"]);

/** A language, by the name the editor and the language servers both use. */
export type LanguageId = "typescript" | "tsx" | "javascript" | "python" | "rust" | "go" | "java";

/** What a tool plugin contributes to answer questions about code. `runs` says where: in a Worker
 *  beside the editor, or in the sidecar process on the machine holding the files. */
export interface CodeIntelContribution {
  languages: LanguageId[];
  runs: "worker" | "sidecar";
  accuracy: Accuracy;
  answers: Question[];
}

export interface Place { line: number; col: number }

export interface Span { start: Place; end: Place }

export type SymbolKind =
  | "function" | "method" | "class" | "interface" | "type" | "enum" | "variable" | "constant"
  | "field" | "property" | "module" | "constructor";

/** One entry of a file's outline. */
export interface CodeSymbol {
  name: string;
  kind: SymbolKind;
  /** The whole declaration. */
  span: Span;
  /** Where its name is. */
  nameAt: Place;
  children: CodeSymbol[];
}

/** Lines that fold: from the end of `startLine` to the end of `endLine`, both 1-based. */
export interface FoldRange { startLine: number; endLine: number }

/** A place in a file, relative to the workspace when inside it. */
export interface CodeLocation {
  file: string;
  span: Span;
  /** The line it is on, cut at 400 characters, when known. */
  text?: string;
}

export interface Hover {
  /** Markdown. */
  text: string;
  span?: Span;
}

/** What each question answers with. */
export interface Answers {
  documentSymbol: CodeSymbol[];
  foldingRange: FoldRange[];
  definition: CodeLocation[];
  references: CodeLocation[];
  hover: Hover | null;
  callHierarchy: CodeLocation[];
  rename: { file: string; edits: { span: Span; text: string }[] }[];
  diagnostic: { span: Span; message: string; severity: "error" | "warning" | "info" }[];
  workspaceSymbol: CodeLocation[];
}

/** One provider's answer, for the version of the file it was asked about. */
export interface Answer<Q extends Question = Question> {
  question: Q;
  value: Answers[Q];
  accuracy: Accuracy;
  /** The document version it was asked for; the caller's counter, given back unchanged. */
  version: number;
  /** Which provider answered. */
  by: string;
  /** What a compiler answer covers when that is less than the workspace (the projects its server
   *  loaded); absent when it covers all of it. */
  partial?: string;
  /** With a `partial` list answer: the places a less accurate provider found that it did not,
   *  kept beside it rather than dropped. */
  also?: { accuracy: Accuracy; by: string; value: CodeLocation[] };
}

/** What a provider gives back: its answer, and what it covers when that is less than the workspace. */
export interface Reply<Q extends Question = Question> {
  value: Answers[Q];
  partial?: string;
}

/** The file a question is about. */
export interface CodeDocument {
  /** Absolute path. */
  file: string;
  language: LanguageId;
  version: number;
  /** The text being edited; a provider that reads the disk ignores it. */
  text?: string;
}

/** Something that answers questions about code. */
export interface CodeIntelProvider extends CodeIntelContribution {
  id: string;
  /** The answer, or null when this provider has none for it (an unknown word, a server that did
   *  not start). Throwing counts as null. */
  ask<Q extends Question>(question: Q, doc: CodeDocument, at?: Place): Promise<Reply<Q> | null>;
}

const EXTENSIONS: Record<string, LanguageId> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  py: "python", pyi: "python", rs: "rust", go: "go", java: "java",
};

/** The language of a file by its extension, or null when no provider knows it. */
export function languageOf(file: string): LanguageId | null {
  const dot = file.lastIndexOf(".");
  return dot < 0 ? null : EXTENSIONS[file.slice(dot + 1).toLowerCase()] ?? null;
}
