// Reading log lines' levels and filtering them. No imports: the tests load it as it is.

export const LEVELS = ["error", "warn", "info", "debug"];

const WORDS = [
  ["error", /\b(ERROR|ERR|FATAL|CRITICAL|CRIT|PANIC|SEVERE|EMERG|ALERT)\b|\blevel=(error|fatal|crit\w*|panic)\b/i],
  ["warn", /\b(WARN|WARNING)\b|\blevel=warn(ing)?\b/i],
  ["info", /\b(INFO|NOTICE)\b|\blevel=info\b/i],
  ["debug", /\b(DEBUG|TRACE)\b|\blevel=(debug|trace)\b/i],
];

/** A numeric level, as some JSON loggers write it: 10 trace … 60 fatal. */
const byNumber = (n) => (n >= 50 ? "error" : n >= 40 ? "warn" : n >= 30 ? "info" : "debug");

function byWord(w) {
  const s = String(w).toLowerCase();
  if (/^(error|err|fatal|crit|critical|panic|severe|emerg|alert)$/.test(s)) return "error";
  if (/^(warn|warning)$/.test(s)) return "warn";
  if (/^(info|notice|information)$/.test(s)) return "info";
  if (/^(debug|trace|verbose)$/.test(s)) return "debug";
  return null;
}

/** A line's level, or null: a JSON line's `level` field, else the first level word in it. */
export function levelOf(line) {
  const t = line.trim();
  if (t.startsWith("{")) {
    try {
      const o = JSON.parse(t);
      const v = o.level ?? o.lvl ?? o.severity ?? o.log?.level;
      if (typeof v === "number") return byNumber(v);
      if (v !== undefined) return byWord(v);
    } catch { /* not JSON after all */ }
  }
  // The level word nearest the start wins, so a message quoting "error" stays at its own level.
  let best = null;
  for (const [level, re] of WORDS) {
    const m = re.exec(line);
    if (m && (best === null || m.index < best.at)) best = { level, at: m.index };
  }
  return best?.level ?? null;
}

/** A JSON line's message, for showing; other lines as they are. */
export function messageOf(line) {
  const t = line.trim();
  if (!t.startsWith("{")) return line;
  try {
    const o = JSON.parse(t);
    const msg = o.msg ?? o.message;
    if (typeof msg !== "string") return line;
    const time = o.time ?? o.timestamp ?? o.ts;
    const rest = Object.entries(o).filter(([k]) => !["msg", "message", "level", "lvl", "severity", "time", "timestamp", "ts", "pid", "hostname", "v"].includes(k))
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
    const when = typeof time === "string" ? `${time} ` : typeof time === "number" ? `${new Date(time > 1e12 ? time : time * 1000).toISOString()} ` : "";
    return `${when}${msg}${rest.length ? `  ${rest.join(" ")}` : ""}`;
  } catch { return line; }
}

/** A filter as a test: `/re/flags` is a regular expression, anything else text found ignoring case. */
export function makeFilter(text) {
  const s = String(text ?? "").trim();
  if (!s) return { test: () => true, error: null };
  const re = /^\/(.+)\/([gimsuy]*)$/.exec(s);
  if (re) {
    try {
      const r = new RegExp(re[1], re[2].replace("g", ""));
      return { test: (l) => r.test(l), error: null };
    } catch (e) {
      return { test: () => true, error: e.message };
    }
  }
  const lower = s.toLowerCase();
  return { test: (l) => l.toLowerCase().includes(lower), error: null };
}

/** The lines `tail` printed, each with its level; a line without one takes the line before's (a stack trace's). */
export function readLines(out) {
  const lines = out.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  let last = null;
  return lines.map((text, i) => {
    const own = levelOf(text);
    const level = own ?? (/^\s+(at |\.\.\.|File ")|^\s*Caused by|^Traceback|^[\w.]*(Error|Exception):/.test(text) ? last : null);
    if (own) last = own;
    return { n: i, text, level };
  });
}

/** How many lines of each level. */
export function countLevels(lines) {
  const counts = Object.fromEntries(LEVELS.map((l) => [l, 0]));
  for (const l of lines) if (l.level) counts[l.level]++;
  return counts;
}
