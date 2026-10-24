// The JQL subset the sync builds, interpreted against the live site model.
//
// Two kinds of failure, as in Jira:
// - a syntax error throws `JqlSyntaxError` (400 everywhere);
// - an unknown field, function or value is a *semantic* error. Cloud (CHANGE-3131, 2026-06-29)
//   answers zero results for that clause and no error; Data Center answers 400 unless the search
//   sets `validateQuery=false`. `compileJql` returns the errors so each endpoint picks its rule,
//   and `POST /jql/parse?validation=strict` reports them.
//
// Semantics chosen where Jira's docs are silent: an invalid clause matches nothing (so an AND-ed
// scope returns zero, as the sync's empty-scope guard expects); an unknown value inside a list
// matches nothing while the other values still match; ties in ORDER BY fall back to id order.
import type { Site, SiteIssue } from "./site.js";
import { parseJiraTime, zoneOffset, zonedToEpoch } from "./time.js";

export class JqlSyntaxError extends Error {}

type Value = { kind: "str"; v: string } | { kind: "fn"; name: string; args: string[] } | { kind: "empty" };
type Op = "=" | "!=" | ">" | ">=" | "<" | "<=" | "~" | "!~" | "in" | "not in" | "is" | "is not" | "history";
export type Clause = { kind: "clause"; field: string; op: Op; values: Value[] };
export type JqlNode = Clause | { kind: "and"; a: JqlNode; b: JqlNode } | { kind: "or"; a: JqlNode; b: JqlNode } | { kind: "not"; a: JqlNode };
export type JqlQuery = { where?: JqlNode; orderBy: { field: string; dir: "asc" | "desc" }[] };

// ── Lexer ────────────────────────────────────────────────────────────────────────────────────

type Tok = { t: "(" | ")" | "," | "op" | "word" | "str" | "eof"; v: string; pos: number };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === "(" || c === ")" || c === ",") { out.push({ t: c, v: c, pos: i }); i++; continue; }
    const two = src.slice(i, i + 2);
    if (two === "&&" || two === "||") { out.push({ t: "word", v: two === "&&" ? "AND" : "OR", pos: i }); i += 2; continue; }
    if (["!=", ">=", "<=", "!~"].includes(two)) { out.push({ t: "op", v: two, pos: i }); i += 2; continue; }
    if ("=><~".includes(c)) { out.push({ t: "op", v: c, pos: i }); i++; continue; }
    if (c === "!") { out.push({ t: "word", v: "NOT", pos: i }); i++; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1, v = "";
      while (j < src.length && src[j] !== c) { if (src[j] === "\\" && j + 1 < src.length) j++; v += src[j]; j++; }
      if (j >= src.length) throw new JqlSyntaxError(`Error in the JQL Query: The quoted string '${v}' has not been completed. (line 1, character ${i + 1})`);
      out.push({ t: "str", v, pos: i });
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < src.length && !/[\s(),=!<>~"']/.test(src[j]!)) j++;
    out.push({ t: "word", v: src.slice(i, j), pos: i });
    i = j;
  }
  out.push({ t: "eof", v: "", pos: src.length });
  return out;
}

// ── Parser ───────────────────────────────────────────────────────────────────────────────────

export function parseJql(src: string): JqlQuery {
  const toks = lex(src);
  let k = 0;
  const peek = () => toks[k]!;
  const isWord = (w: string, t = peek()) => t.t === "word" && t.v.toUpperCase() === w;
  const fail = (what: string): never => {
    const t = peek();
    throw new JqlSyntaxError(`Error in the JQL Query: Expecting ${what} but got ${t.t === "eof" ? "the end of the query" : `'${t.v}'`}. (line 1, character ${t.pos + 1})`);
  };

  const value = (): Value => {
    const t = peek();
    if (t.t === "str") { k++; return { kind: "str", v: t.v }; }
    if (t.t !== "word") return fail("a value");
    k++;
    if (isWord("EMPTY", t) || isWord("NULL", t)) return { kind: "empty" };
    if (peek().t === "(") {
      k++;
      const args: string[] = [];
      while (peek().t !== ")") {
        const a = peek();
        if (a.t !== "word" && a.t !== "str") fail("a function argument");
        args.push(a.v); k++;
        if (peek().t === ",") k++;
        else if (peek().t !== ")") fail("',' or ')'");
      }
      k++;
      return { kind: "fn", name: t.v, args };
    }
    return { kind: "str", v: t.v };
  };
  const list = (): Value[] => {
    if (peek().t !== "(") return [value()]; // `in membersOf(…)`-style function lists
    k++;
    const vs = [value()];
    while (peek().t === ",") { k++; vs.push(value()); }
    if (peek().t !== ")") fail("',' or ')'");
    k++;
    return vs;
  };
  // WAS / CHANGED predicates: parsed so a real-world query isn't a syntax error, then refused as unsupported.
  const historyPredicates = () => {
    while (["AFTER", "BEFORE", "ON", "DURING", "BY", "FROM", "TO"].some((w) => isWord(w))) {
      k++;
      if (peek().t === "(") list(); else value();
    }
  };
  const clause = (): JqlNode => {
    const f = peek();
    if (f.t !== "word" && f.t !== "str") return fail("a field name");
    k++;
    const field = f.v;
    const t = peek();
    if (t.t === "op") { k++; return { kind: "clause", field, op: t.v as Op, values: [value()] }; }
    if (isWord("IN")) { k++; return { kind: "clause", field, op: "in", values: list() }; }
    if (isWord("NOT") && isWord("IN", toks[k + 1])) { k += 2; return { kind: "clause", field, op: "not in", values: list() }; }
    if (isWord("IS")) {
      k++;
      const not = isWord("NOT") ? (k++, true) : false;
      return { kind: "clause", field, op: not ? "is not" : "is", values: [value()] };
    }
    if (isWord("WAS")) {
      k++;
      if (isWord("NOT")) k++;
      if (isWord("IN")) { k++; list(); } else value();
      historyPredicates();
      return { kind: "clause", field, op: "history", values: [] };
    }
    if (isWord("CHANGED")) { k++; historyPredicates(); return { kind: "clause", field, op: "history", values: [] }; }
    return fail("operator");
  };
  const unary = (): JqlNode => {
    if (isWord("NOT")) { k++; return { kind: "not", a: unary() }; }
    if (peek().t === "(") {
      k++;
      const e = or();
      if (peek().t !== ")") fail("')'");
      k++;
      return e;
    }
    return clause();
  };
  const and = (): JqlNode => {
    let a = unary();
    while (isWord("AND")) { k++; a = { kind: "and", a, b: unary() }; }
    return a;
  };
  const or = (): JqlNode => {
    let a = and();
    while (isWord("OR")) { k++; a = { kind: "or", a, b: and() }; }
    return a;
  };

  const q: JqlQuery = { orderBy: [] };
  if (!isWord("ORDER") && peek().t !== "eof") q.where = or();
  if (isWord("ORDER")) {
    k++;
    if (!isWord("BY")) fail("'BY'");
    k++;
    do {
      if (peek().t === ",") k++;
      const f = peek();
      if (f.t !== "word" && f.t !== "str") fail("a field name");
      k++;
      let dir: "asc" | "desc" = "asc";
      if (isWord("ASC")) k++;
      else if (isWord("DESC")) { k++; dir = "desc"; }
      q.orderBy.push({ field: f.v, dir });
    } while (peek().t === ",");
  }
  if (peek().t !== "eof") fail(q.where ? "either 'OR' or 'AND'" : "a field name");
  return q;
}

// ── Evaluation ───────────────────────────────────────────────────────────────────────────────

export interface JqlContext {
  site: Site;
  /** The searching user's reference (accountId on Cloud, username on DC). */
  me: string;
  /** myself's time zone, used for date literals (falls back to the server's). */
  timeZone: string;
  now: number;
}

export interface CompiledJql {
  matches(issue: SiteIssue): boolean;
  compare(a: SiteIssue, b: SiteIssue): number;
  /** Semantic errors, worded as Jira words them. Empty = valid. */
  errors: string[];
}

type Pred = (i: SiteIssue) => boolean;
const NONE: Pred = () => false;

const FIELD_ALIASES: Record<string, string> = {
  type: "issuetype", issuekey: "key", issue: "key", updateddate: "updated", createddate: "created", text: "summary",
};

export function compileJql(q: JqlQuery, ctx: JqlContext): CompiledJql {
  const errors: string[] = [];
  const { site } = ctx;
  const customField = (name: string) => site.fields.find((f) => f.clauseNames.some((c) => c.toLowerCase() === name.toLowerCase()) && f.custom);
  const fieldName = (raw: string): string | undefined => {
    const lower = raw.toLowerCase();
    const alias = FIELD_ALIASES[lower] ?? lower;
    if (HANDLERS[alias]) return alias;
    const cf = customField(raw);
    if (cf?.schema?.custom === "com.pyxis.greenhopper.jira:gh-sprint") return "sprint";
    if (cf?.schema?.custom === "com.pyxis.greenhopper.jira:gh-lexo-rank") return "rank";
    return undefined;
  };

  const statusById = new Map(site.statuses.map((s) => [s.id, s]));
  const userRefs = (u: Site["users"][number]) => [u.accountId, u.name, u.key].filter((x): x is string => !!x);
  const byKey = (ref: string) => {
    const up = ref.toUpperCase();
    return site.issues.find((i) => i.key === up || i.previousKeys.includes(up) || i.id === ref);
  };

  // Each handler turns a clause's values into a predicate, pushing errors for what it can't resolve.
  type Handler = (c: Clause, err: (m: string) => void) => Pred;
  const valuesIn = (c: Clause, field: string, err: (m: string) => void, resolve: (v: Value) => (string | null)[] | undefined, get: (i: SiteIssue) => (string | null)[]): Pred => {
    const isEmptyOp = c.op === "is" || c.op === "is not";
    if (isEmptyOp) {
      if (c.values[0]?.kind !== "empty") { err(`The operator '${c.op.toUpperCase()}' only supports EMPTY or NULL for the field '${field}'.`); return NONE; }
      const empty: Pred = (i) => get(i).filter((x) => x !== null).length === 0;
      return c.op === "is" ? empty : (i) => !empty(i);
    }
    if (!["=", "!=", "in", "not in"].includes(c.op)) { err(`The operator '${c.op}' is not supported by the '${field}' field.`); return NONE; }
    const wanted = new Set<string | null>();
    for (const v of c.values) {
      if (v.kind === "empty") { wanted.add(null); continue; }
      const r = resolve(v);
      if (r === undefined) continue; // resolve pushed the error; this value matches nothing
      for (const x of r) wanted.add(x);
    }
    const hit: Pred = (i) => {
      const have = get(i);
      return (have.length === 0 ? [null] : have).some((x) => wanted.has(x));
    };
    return c.op === "=" || c.op === "in" ? hit : (i) => !hit(i);
  };
  const noValue = (field: string, v: Value, err: (m: string) => void) =>
    v.kind === "fn" ? err(`Unable to find JQL function '${v.name}(${v.args.join(", ")})'.`) : err(`The value '${v.kind === "str" ? v.v : "EMPTY"}' does not exist for the field '${field}'.`);

  const dateValue = (field: string, v: Value, err: (m: string) => void): number | undefined => {
    if (v.kind === "fn") {
      const name = v.name.toLowerCase();
      if (name === "now") return ctx.now;
      if (name === "startofday" || name === "endofday") {
        const local = new Date(ctx.now + zoneOffset(ctx.timeZone, ctx.now));
        const [y, mo, d] = [local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate()];
        const start = zonedToEpoch(ctx.timeZone, y, mo, d, 0, 0);
        return name === "startofday" ? start : zonedToEpoch(ctx.timeZone, y, mo, d, 23, 59) + 59_999;
      }
      err(`Unable to find JQL function '${v.name}(${v.args.join(", ")})'.`);
      return undefined;
    }
    if (v.kind === "empty") { err(`The operator does not support EMPTY for the field '${field}'.`); return undefined; }
    const s = v.v.trim();
    const rel = /^([+-]?)((?:\d+[wdhm]\s*)+)$/i.exec(s);
    if (rel) {
      let ms = 0;
      for (const [, n, u] of rel[2]!.matchAll(/(\d+)([wdhm])/gi)) ms += +n! * { w: 604_800_000, d: 86_400_000, h: 3_600_000, m: 60_000 }[u!.toLowerCase() as "w"]!;
      return ctx.now + (rel[1] === "-" ? -ms : ms);
    }
    const abs = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(s);
    if (abs) return zonedToEpoch(ctx.timeZone, +abs[1]!, +abs[2]!, +abs[3]!, abs[4] ? +abs[4] : 0, abs[5] ? +abs[5] : 0);
    err(`Date value '${s}' for field '${field}' is invalid. Valid formats include: 'yyyy/MM/dd HH:mm', 'yyyy-MM-dd HH:mm', 'yyyy/MM/dd', 'yyyy-MM-dd', or a period format e.g. '-5d', '4w 2d'.`);
    return undefined;
  };
  const dateField = (get: (i: SiteIssue) => string): Handler => (c, err) => {
    if (!["=", "!=", ">", ">=", "<", "<="].includes(c.op)) { err(`The operator '${c.op}' is not supported by the '${c.field}' field.`); return NONE; }
    const t = dateValue(c.field, c.values[0]!, err);
    if (t === undefined) return NONE;
    const cmp = { "=": (a: number) => a === t, "!=": (a: number) => a !== t, ">": (a: number) => a > t, ">=": (a: number) => a >= t, "<": (a: number) => a < t, "<=": (a: number) => a <= t }[c.op as "="];
    return (i) => cmp(parseJiraTime(get(i)));
  };
  const userField = (get: (i: SiteIssue) => string | null): Handler => (c, err) =>
    valuesIn(c, c.field, err, (v) => {
      if (v.kind === "fn") {
        if (v.name.toLowerCase() === "currentuser") return [ctx.me];
        noValue(c.field, v, err);
        return undefined;
      }
      if (v.kind !== "str") return undefined;
      const u = site.users.find((u) => userRefs(u).includes(v.v));
      if (!u) { err(`The value '${v.v}' does not exist for the field '${c.field}'.`); return undefined; }
      return userRefs(u);
    }, (i) => [get(i)]);
  const byNameOrId = <T extends { id: string; name: string }>(field: string, items: T[], out: (t: T) => string) => (v: Value, err: (m: string) => void) => {
    if (v.kind !== "str") { noValue(field, v, err); return undefined; }
    const hits = items.filter((t) => t.id === v.v || t.name.toLowerCase() === v.v.toLowerCase());
    if (hits.length === 0) { err(`The value '${v.v}' does not exist for the field '${field}'.`); return undefined; }
    return hits.map(out);
  };

  const HANDLERS: Record<string, Handler> = {
    project: (c, err) => valuesIn(c, "project", err, (v) => {
      if (v.kind !== "str") { noValue("project", v, err); return undefined; }
      const p = site.projects.find((p) => p.id === v.v || p.key.toLowerCase() === v.v.toLowerCase() || p.name.toLowerCase() === v.v.toLowerCase() || p.projectKeys?.some((k) => k.toLowerCase() === v.v.toLowerCase()));
      if (!p) { err(`The value '${v.v}' does not exist for the field 'project'.`); return undefined; }
      return [p.key];
    }, (i) => [i.project]),
    status: (c, err) => valuesIn(c, "status", err, (v) => byNameOrId("status", site.statuses, (s) => s.id)(v, err), (i) => [i.status]),
    statuscategory: (c, err) => valuesIn(c, "statusCategory", err, (v) => {
      if (v.kind !== "str") { noValue("statusCategory", v, err); return undefined; }
      const want = v.v.toLowerCase();
      const cat = site.statuses.map((s) => s.statusCategory).find((sc) => [String(sc.id), sc.key, sc.name.toLowerCase()].includes(want))
        ?? CATEGORIES.find((sc) => [String(sc.id), sc.key, sc.name.toLowerCase()].includes(want));
      if (!cat) { err(`The value '${v.v}' does not exist for the field 'statusCategory'.`); return undefined; }
      return [cat.key];
    }, (i) => [statusById.get(i.status)?.statusCategory.key ?? null]),
    issuetype: (c, err) => valuesIn(c, "issuetype", err, (v) => byNameOrId("issuetype", site.projects.flatMap((p) => p.issueTypes), (t) => t.id)(v, err), (i) => [i.issueType]),
    assignee: userField((i) => i.assignee),
    reporter: userField((i) => i.reporter),
    priority: (c, err) => valuesIn(c, "priority", err, (v) => byNameOrId("priority", site.priorities, (p) => p.name)(v, err), (i) => [i.priority]),
    resolution: (c, err) => valuesIn(c, "resolution", err, (v) => {
      if (v.kind === "str" && v.v.toLowerCase() === "unresolved") return [null];
      return byNameOrId("resolution", site.resolutions, (r) => r.name)(v, err);
    }, (i) => [i.resolution]),
    labels: (c, err) => valuesIn(c, "labels", err, (v) => (v.kind === "str" ? [v.v] : (noValue("labels", v, err), undefined)), (i) => i.labels),
    sprint: (c, err) => valuesIn(c, "sprint", err, (v) => {
      if (v.kind === "fn") {
        const state = { opensprints: "active", futuresprints: "future", closedsprints: "closed" }[v.name.toLowerCase()];
        if (!state) { noValue("sprint", v, err); return undefined; }
        return site.sprints.filter((s) => s.state === state).map((s) => String(s.id));
      }
      if (v.kind !== "str") return undefined;
      const s = site.sprints.filter((s) => String(s.id) === v.v || s.name.toLowerCase() === v.v.toLowerCase());
      if (s.length === 0) { err(`Sprint with name or id '${v.v}' does not exist or you do not have permission to view it.`); return undefined; }
      return s.map((s) => String(s.id));
    }, (i) => i.sprints.map(String)),
    parent: (c, err) => valuesIn(c, "parent", err, (v) => {
      const hit = v.kind === "str" ? byKey(v.v) : undefined;
      if (!hit) { noValue("parent", v, err); return undefined; }
      return [hit.key];
    }, (i) => [i.parent ?? null]),
    key: (c, err) => valuesIn(c, "key", err, (v) => {
      const hit = v.kind === "str" ? byKey(v.v) : undefined;
      if (!hit || hit.deleted || hit.restricted) { err(`An issue with key '${v.kind === "str" ? v.v : ""}' does not exist for field 'key'.`); return undefined; }
      return [hit.id];
    }, (i) => [i.id]),
    id: (c, err) => {
      if ([">", ">=", "<", "<="].includes(c.op)) {
        const n = c.values[0]?.kind === "str" ? Number(c.values[0].v) : Number.NaN;
        if (!Number.isFinite(n)) { err(`The value for the field 'id' must be a number.`); return NONE; }
        const cmp = { ">": (a: number) => a > n, ">=": (a: number) => a >= n, "<": (a: number) => a < n, "<=": (a: number) => a <= n }[c.op as ">"];
        return (i) => cmp(Number(i.id));
      }
      return valuesIn(c, "id", err, (v) => {
        const hit = v.kind === "str" ? site.issues.find((i) => i.id === v.v) : undefined;
        if (!hit || hit.deleted || hit.restricted) { err(`An issue with key '${v.kind === "str" ? v.v : ""}' does not exist for field 'id'.`); return undefined; }
        return [hit.id];
      }, (i) => [i.id]);
    },
    summary: (c, err) => {
      if (c.op !== "~" && c.op !== "!~") { err(`The operator '${c.op}' is not supported by the '${c.field}' field.`); return NONE; }
      const v = c.values[0];
      if (v?.kind !== "str") { noValue(c.field, v!, err); return NONE; }
      const needle = v.v.toLowerCase();
      const hit: Pred = (i) => i.summary.toLowerCase().includes(needle);
      return c.op === "~" ? hit : (i) => !hit(i);
    },
    updated: dateField((i) => i.updated),
    created: dateField((i) => i.created),
  };

  const build = (n: JqlNode): Pred => {
    if (n.kind === "and" || n.kind === "or") {
      const a = build(n.a), b = build(n.b);
      return n.kind === "and" ? (i) => a(i) && b(i) : (i) => a(i) || b(i);
    }
    if (n.kind === "not") { const a = build(n.a); return (i) => !a(i); }
    const name = fieldName(n.field);
    if (!name) { errors.push(`Field '${n.field}' does not exist or you do not have permission to view it.`); return NONE; }
    if (n.op === "history") { errors.push(`The fake Jira does not support the WAS / CHANGED operators (field '${n.field}').`); return NONE; }
    const clauseErrors: string[] = [];
    const pred = HANDLERS[name]!(n, (m) => clauseErrors.push(m));
    errors.push(...clauseErrors);
    return pred;
  };
  const where = q.where ? build(q.where) : () => true;

  const rank = (i: SiteIssue) => site.issues.indexOf(i);
  const keyOrder = (a: SiteIssue, b: SiteIssue) => {
    const [pa, na] = splitKey(a.key), [pb, nb] = splitKey(b.key);
    return pa === pb ? na - nb : pa < pb ? -1 : 1;
  };
  const sorters: ((a: SiteIssue, b: SiteIssue) => number)[] = [];
  for (const o of q.orderBy) {
    const f = fieldName(o.field) ?? (o.field.toLowerCase() === "rank" ? "rank" : undefined);
    const by: ((a: SiteIssue, b: SiteIssue) => number) | undefined =
      f === "updated" ? (a, b) => parseJiraTime(a.updated) - parseJiraTime(b.updated)
      : f === "created" ? (a, b) => parseJiraTime(a.created) - parseJiraTime(b.created)
      : f === "key" ? keyOrder
      : f === "id" ? (a, b) => Number(a.id) - Number(b.id)
      : f === "rank" ? (a, b) => rank(a) - rank(b)
      : undefined;
    if (!by) { errors.push(`Not able to sort using field '${o.field}'.`); continue; }
    sorters.push(o.dir === "desc" ? (a, b) => -by(a, b) : by);
  }
  // No ORDER BY: Jira's default order is unspecified; newest id first here.
  if (sorters.length === 0) sorters.push((a, b) => Number(b.id) - Number(a.id));
  const compare = (a: SiteIssue, b: SiteIssue) => {
    for (const s of sorters) { const r = s(a, b); if (r !== 0) return r; }
    return Number(a.id) - Number(b.id);
  };

  return { matches: where, compare, errors };
}

const CATEGORIES = [
  { id: 2, key: "new", name: "To Do" },
  { id: 4, key: "indeterminate", name: "In Progress" },
  { id: 3, key: "done", name: "Done" },
  { id: 1, key: "undefined", name: "No Category" },
];

function splitKey(key: string): [string, number] {
  const i = key.lastIndexOf("-");
  return [key.slice(0, i), Number(key.slice(i + 1))];
}
