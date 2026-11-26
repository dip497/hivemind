/**
 * The order answers are taken in: every provider for the file's language is asked at once, the
 * first answer is given straight away, and a more accurate one replaces it when it comes. An
 * answer for a version of the file older than the latest one seen is dropped. Rename is asked of
 * compiler-accurate providers only. Used beside the editor and in the sidecar alike. No I/O here.
 */
import { ACCURACY_RANK, NEEDS_COMPILER, type Accuracy, type Answer, type CodeDocument, type CodeIntelProvider, type CodeLocation, type Place, type Question } from "./contract.js";

export interface AskOptions<Q extends Question> {
  /** Each answer better than the one before: the fastest first, then a more accurate one. */
  onAnswer?(answer: Answer<Q>): void;
  /** Give the best answer so far after this many ms instead of waiting for every provider. */
  within?: number;
  /** Taken back (the cursor moved): the answer is null and nothing more is told. */
  signal?: AbortSignal;
}

/** Nothing found counts as no answer, so it never replaces something found. */
const found = (v: unknown): boolean => v != null && !(Array.isArray(v) && v.length === 0);

export class CodeAnswers {
  /** The latest version seen of each file. */
  private readonly latest = new Map<string, number>();

  constructor(private readonly providers: () => readonly CodeIntelProvider[]) {}

  /** The file is now at `version`: answers asked about an older one are dropped. */
  edited(file: string, version: number): void {
    if (version > (this.latest.get(file) ?? -Infinity)) this.latest.set(file, version);
  }

  /** Whether an answer about `version` of the file is still about its latest version. */
  current(file: string, version: number): boolean { return (this.latest.get(file) ?? version) <= version; }

  /** Forget a file closed in the editor. */
  closed(file: string): void { this.latest.delete(file); }

  /** Who would be asked `question` about `doc`. */
  askable(question: Question, doc: Pick<CodeDocument, "language">): CodeIntelProvider[] {
    return this.providers().filter((p) =>
      p.languages.includes(doc.language) && p.answers.includes(question) && (!NEEDS_COMPILER.has(question) || p.accuracy === "compiler"));
  }

  /** The most accurate answer for this version of the file, or null when none came, the file
   *  moved on before it did, or the question was taken back. A compiler answer that covers only
   *  part of the workspace keeps the less accurate places it lacks beside it (`also`). */
  ask<Q extends Question>(question: Q, doc: CodeDocument, at?: Place, opts: AskOptions<Q> = {}): Promise<Answer<Q> | null> {
    this.edited(doc.file, doc.version);
    const asked = this.askable(question, doc);
    if (asked.length === 0 || opts.signal?.aborted) return Promise.resolve(null);
    const top = Math.max(...asked.map((p) => ACCURACY_RANK[p.accuracy]));
    const stale = () => !this.current(doc.file, doc.version);
    let best: Answer<Q> | null = null;
    /** The best list answer below `best`, for a partial one to keep beside it. */
    let below: { accuracy: Accuracy; by: string; value: CodeLocation[] } | null = null;
    return new Promise((resolve) => {
      let left = asked.length;
      let done = false;
      const timer = opts.within === undefined ? null : setTimeout(() => finish(), opts.within);
      const finish = (cancelled = false) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener("abort", cancel);
        resolve(best && !cancelled && !stale() ? best : null);
      };
      const cancel = () => finish(true);
      opts.signal?.addEventListener("abort", cancel);
      const tell = (a: Answer<Q>) => { best = a; opts.onAnswer?.(a); };
      for (const p of asked) {
        p.ask(question, doc, at).catch(() => null).then((reply) => {
          left--;
          if (done || !reply || !found(reply.value) || stale()) { if (left === 0) finish(); return; }
          const rank = ACCURACY_RANK[p.accuracy];
          const list = Array.isArray(reply.value) ? reply.value as CodeLocation[] : null;
          if (!best || rank > ACCURACY_RANK[best.accuracy]) {
            if (best && Array.isArray(best.value)) below = { accuracy: best.accuracy, by: best.by, value: best.value as CodeLocation[] };
            const next: Answer<Q> = { question, value: reply.value, accuracy: p.accuracy, version: doc.version, by: p.id, ...(reply.partial ? { partial: reply.partial } : {}) };
            const also = reply.partial && list && below ? missing(below.value, list) : [];
            tell(also.length && below ? { ...next, also: { ...below, value: also } } : next);
            if (rank === top && !reply.partial) return finish();
          } else if (best.partial && list && Array.isArray(best.value) && (!best.also || rank > ACCURACY_RANK[best.also.accuracy])) {
            const also = missing(list, best.value as CodeLocation[]);
            if (also.length) tell({ ...best, also: { accuracy: p.accuracy, by: p.id, value: also } });
          }
          if (left === 0) finish();
        });
      }
    });
  }
}

/** The places of `from` that `known` does not hold. */
function missing(from: CodeLocation[], known: CodeLocation[]): CodeLocation[] {
  const at = new Set(known.map((l) => `${l.file}:${l.span.start.line}:${l.span.start.col}`));
  return from.filter((l) => !at.has(`${l.file}:${l.span.start.line}:${l.span.start.col}`));
}
