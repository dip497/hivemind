/**
 * Definitions or usages, grouped by file, each line clickable. The header says how sure the
 * answer is: from the language's compiler, or from the syntax alone (a search for the word, which
 * can hold places that only share the name). Also the hover card's body (`CodeHoverText`).
 */
import { useMemo } from "react";
import type { Accuracy, Answer, CodeLocation } from "@hivemind/code-intel/contract";
import { Badge } from "../components/ui/badge";
import { MarkdownPreview } from "../markdown-preview";

const SURE: Record<Accuracy, string> = {
  compiler: "from the compiler",
  index: "from the workspace index",
  syntax: "from the text: places that only share the name may be here",
};

export function CodeResults({ title, answer, loading = false, error, onOpen }: {
  /** "Usages of total", "Definition of areaOf". */
  title: string;
  answer: Answer<"definition"> | Answer<"references"> | null;
  loading?: boolean;
  /** Why the question could not be answered. */
  error?: string;
  /** `col` from 0, as the workspace API counts it. */
  onOpen: (file: string, line: number, col: number) => void;
}) {
  const groups = useMemo(() => byFile(answer?.value ?? []), [answer]);
  const alsoGroups = useMemo(() => byFile(answer?.also?.value ?? []), [answer]);
  const count = answer?.value.length ?? 0;
  const list = (gs: [string, CodeLocation[]][], by: string) => gs.map(([file, places]) => (
    <li key={`${by}:${file}`}>
      <div className="flex items-center gap-2 px-2 h-6 text-label font-semibold text-[var(--color-fg)]" data-code-results-file={file}>
        <span className="truncate">{file}</span><span className="ml-auto text-count font-normal text-[var(--color-fg3)]">{places.length}</span>
      </div>
      <ul>
        {places.map((p) => (
          <li key={`${p.span.start.line}:${p.span.start.col}`}>
            <button type="button" data-code-result={`${file}:${p.span.start.line}`} data-found-by={by} onClick={() => onOpen(file, p.span.start.line, p.span.start.col)}
              className="w-full flex items-center gap-2 h-6 pl-5 pr-2 text-left rounded-sm hover:bg-[var(--color-bg3)] focus-visible:bg-[var(--color-bg3)] font-mono text-count text-[var(--color-fg2)] whitespace-pre overflow-hidden"
              title={`${file}:${p.span.start.line}:${p.span.start.col + 1}`}>
              <span className="shrink-0 w-8 text-right text-[var(--color-fg3)] tabular-nums">{p.span.start.line}</span>
              <span className="truncate">{p.text?.trim() ?? ""}</span>
            </button>
          </li>
        ))}
      </ul>
    </li>
  ));

  return (
    <div className="flex flex-col h-full min-h-0 bg-[var(--color-bg2)]" data-code-results>
      <div className="shrink-0 px-2 py-1.5 border-b border-[var(--color-line)] flex items-center gap-2">
        <span className="text-label font-semibold text-[var(--color-fg)] truncate">{title}</span>
        {answer && <Badge variant={answer.accuracy === "compiler" ? "secondary" : "outline"} title={SURE[answer.accuracy]} data-accuracy={answer.accuracy}>{answer.accuracy}</Badge>}
        <span className="ml-auto text-count text-[var(--color-fg3)] tabular-nums">
          {loading ? "asking…" : error ? "" : `${count} in ${groups.length} file${groups.length === 1 ? "" : "s"}`}
        </span>
      </div>
      {answer?.accuracy === "syntax" && <p className="shrink-0 px-2 py-1 text-count text-[var(--color-fg3)]">No language server answered: {SURE.syntax}.</p>}
      {answer?.partial && <p className="shrink-0 px-2 py-1 text-count text-[var(--color-fg3)]" data-partial>The compiler looked in {answer.partial} only.</p>}
      <ul className="nowheel flex-1 min-h-0 overflow-y-auto py-1" aria-label={title}>
        {error && <li className="px-3 py-2 text-count text-[var(--color-fg2)]" data-code-results-error>{error}</li>}
        {!loading && !error && count === 0 && <li className="px-3 py-2 text-count text-[var(--color-fg3)]">Nothing found</li>}
        {list(groups, "answer")}
        {answer?.also && answer.also.value.length > 0 && (
          <li className="px-2 pt-2 pb-1 text-count text-[var(--color-fg3)]" data-code-results-also>
            Not in the compiler's answer, found by {answer.also.accuracy === "syntax" ? "text" : answer.also.accuracy} (may only share the name):
          </li>
        )}
        {list(alsoGroups, "also")}
      </ul>
    </div>
  );
}

function byFile(places: CodeLocation[]): [string, CodeLocation[]][] {
  const out = new Map<string, CodeLocation[]>();
  for (const l of places) out.set(l.file, [...(out.get(l.file) ?? []), l]);
  return [...out];
}

/** What a hover shows: the language server's markdown (signature and doc comment), sanitised. */
export function CodeHoverText({ answer }: { answer: Answer<"hover"> | null }) {
  if (!answer?.value) return null;
  return (
    <div className="max-w-[min(560px,80vw)] max-h-72 overflow-auto" data-code-hover data-accuracy={answer.accuracy}>
      <MarkdownPreview source={answer.value.text} className="md-preview text-label px-3 py-2" />
    </div>
  );
}
