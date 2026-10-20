/** What `hive plugins check` finds: a problem, at the file and line it is in when that is known. */
import fs from "node:fs";
import path from "node:path";

export type CheckStep = "types" | "manifest" | "draw";

export interface Problem {
  step: CheckStep;
  /** Relative to the plugin's folder. */
  file?: string;
  line?: number;
  column?: number;
  message: string;
}

/** The first place in `stack` inside `dir`: where the plugin's own code was when it failed. */
export function placeIn(stack: string, dir: string): Pick<Problem, "file" | "line" | "column"> {
  const root = path.resolve(dir) + path.sep;
  for (const m of stack.matchAll(/((?:file:\/\/)?(?:\/|[A-Za-z]:[\\/])[^\s()]+?):(\d+):(\d+)/g)) {
    const file = m[1]!.replace(/^file:\/\//, "").replace(/\?.*$/, "");
    if (!file.startsWith(root)) continue;
    const at = sourceOf(file, Number(m[2]), Number(m[3])) ?? { file, line: Number(m[2]), column: Number(m[3]) };
    return { ...at, file: path.relative(dir, at.file) };
  }
  return {};
}

/** A thrown value as a problem of `step`, placed by its stack. */
export function thrown(step: CheckStep, e: unknown, dir: string, prefix = ""): Problem {
  // From another realm (a widget's context) an error is no `instanceof Error` here.
  const err = e && typeof e === "object" && "message" in e ? e as { name?: string; message: string; stack?: string } : null;
  const message = prefix + (err ? `${!err.name || err.name === "Error" ? "" : `${err.name}: `}${err.message}` : String(e));
  return { step, message, ...(err?.stack ? placeIn(err.stack, dir) : {}) };
}

export const where = (p: Problem): string =>
  p.file ? `${p.file}${p.line ? `:${p.line}${p.column ? `:${p.column}` : ""}` : ""}` : "";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Where a built file's line and column came from, by the source map beside it (`<file>.map`). */
function sourceOf(file: string, line: number, column: number): { file: string; line: number; column: number } | null {
  let map: { sources?: string[]; mappings?: string; sourceRoot?: string };
  try { map = JSON.parse(fs.readFileSync(`${file}.map`, "utf8")); } catch { return null; }
  if (!map.mappings || !map.sources) return null;
  let src = 0, srcLine = 0, srcCol = 0, best: [number, number, number] | null = null;
  const lines = map.mappings.split(";");
  for (let l = 0; l < lines.length && l < line; l++) {
    let genCol = 0;
    for (const seg of lines[l]!.split(",")) {
      if (!seg) continue;
      const v: number[] = [];
      for (let i = 0, shift = 0, n = 0; i < seg.length; i++) {
        const d = B64.indexOf(seg[i]!);
        n += (d & 31) << shift;
        if (d & 32) { shift += 5; continue; }
        v.push(n & 1 ? -(n >>> 1) : n >>> 1);
        n = 0; shift = 0;
      }
      genCol += v[0] ?? 0;
      if (v.length >= 4) { src += v[1]!; srcLine += v[2]!; srcCol += v[3]!; }
      if (l === line - 1 && v.length >= 4 && genCol <= column - 1) best = [src, srcLine, srcCol];
    }
  }
  if (!best || !map.sources[best[0]]) return null;
  return { file: path.resolve(path.dirname(file), map.sourceRoot ?? "", map.sources[best[0]]!), line: best[1] + 1, column: best[2] + 1 };
}
