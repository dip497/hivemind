/**
 * Three people typing in one note (docs/design/multiplayer-2026-09-28.md §4.4): a text a writer
 * changed from the one it read (`base`), while someone else changed it too (`theirs`), merged so
 * that nobody's typing is lost. Each side's edits are found by a character diff from `base`
 * (Myers), and both are made to `base`: edits in different places each land where they were
 * made; where both touched the same place, both insertions are kept (the writer's first) and
 * whatever either deleted goes. Plain code, no document: the window runs it too.
 */

/** One edit to `base`: replace base[start, end) with `insert`. */
interface Edit {
  start: number;
  end: number;
  insert: string;
}

export function mergeText(base: string, mine: string, theirs: string): string {
  if (mine === theirs || theirs === base) return mine;
  if (mine === base) return theirs;
  const a = edits(base, mine);
  const b = edits(base, theirs);
  let out = "";
  let at = 0;
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    // The next edit, and every edit on either side that overlaps it, as one.
    const first = j >= b.length || (i < a.length && a[i]!.start <= b[j]!.start) ? a[i]! : b[j]!;
    let start = first.start;
    let end = first.end;
    let mineIn = "";
    let theirsIn = "";
    let grew = true;
    while (grew) {
      grew = false;
      while (i < a.length && overlaps(a[i]!, start, end)) {
        start = Math.min(start, a[i]!.start);
        end = Math.max(end, a[i]!.end);
        mineIn += a[i]!.insert;
        i++;
        grew = true;
      }
      while (j < b.length && overlaps(b[j]!, start, end)) {
        start = Math.min(start, b[j]!.start);
        end = Math.max(end, b[j]!.end);
        theirsIn += b[j]!.insert;
        j++;
        grew = true;
      }
    }
    out += base.slice(at, start) + mineIn + theirsIn;
    at = end;
  }
  return out + base.slice(at);
}

/** Whether `e` touches [start, end): overlapping it, or inserting at the same place. */
function overlaps(e: Edit, start: number, end: number): boolean {
  if (e.start === e.end || start === end) return e.start <= end && start <= e.end;
  return e.start < end && start < e.end;
}

/** The edits that make `to` of `from`, in order, none overlapping another. */
function edits(from: string, to: string): Edit[] {
  const out: Edit[] = [];
  let pending: Edit | null = null;
  let x = 0;
  let y = 0;
  const flush = (): void => {
    if (pending) out.push(pending);
    pending = null;
  };
  for (const [kind, n] of diff(from, to)) {
    if (kind === "=") {
      flush();
      x += n;
      y += n;
    } else if (kind === "-") {
      pending ??= { start: x, end: x, insert: "" };
      pending.end = x + n;
      x += n;
    } else {
      pending ??= { start: x, end: x, insert: "" };
      pending.insert += to.slice(y, y + n);
      y += n;
    }
  }
  flush();
  return out;
}

type Op = ["=" | "-" | "+", number];

/** The shortest edit script from `a` to `b` (Myers, O((N+M)D)), as runs. */
function diff(a: string, b: string): Op[] {
  // Common ends first: most edits are a few characters in a long text.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const n = A.length;
  const m = B.length;
  const middle: Op[] = [];
  if (n === 0 && m > 0) middle.push(["+", m]);
  else if (m === 0 && n > 0) middle.push(["-", n]);
  else if (n > 0 && m > 0) {
    const max = n + m;
    const v = new Int32Array(2 * max + 2);
    const trace: Int32Array[] = [];
    let found = false;
    for (let d = 0; d <= max && !found; d++) {
      trace.push(v.slice());
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[max + k - 1]! < v[max + k + 1]!) ? v[max + k + 1]! : v[max + k - 1]! + 1;
        let y = x - k;
        while (x < n && y < m && A[x] === B[y]) { x++; y++; }
        v[max + k] = x;
        if (x >= n && y >= m) { found = true; break; }
      }
    }
    // Walk back through the trace, from the end.
    const steps: ("=" | "-" | "+")[] = [];
    let x = n;
    let y = m;
    for (let d = trace.length - 1; d > 0; d--) {
      const vd = trace[d]!;
      const k = x - y;
      const prevK = k === -d || (k !== d && vd[max + k - 1]! < vd[max + k + 1]!) ? k + 1 : k - 1;
      const prevX = vd[max + prevK]!;
      const prevY = prevX - prevK;
      while (x > prevX && y > prevY) { steps.push("="); x--; y--; }
      steps.push(x === prevX ? "+" : "-");
      x = prevX;
      y = prevY;
    }
    while (x > 0 && y > 0) { steps.push("="); x--; y--; }
    steps.reverse();
    for (const s of steps) {
      const last = middle[middle.length - 1];
      if (last && last[0] === s) last[1]++;
      else middle.push([s, 1]);
    }
  }
  const ops: Op[] = [];
  if (pre) ops.push(["=", pre]);
  ops.push(...middle);
  if (suf) ops.push(["=", suf]);
  return ops;
}
