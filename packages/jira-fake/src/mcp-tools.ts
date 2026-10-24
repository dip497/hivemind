// The fake Rovo MCP server's tools: the catalogue captured from the live server
// (fixtures/rovo-mcp-tools.json) and handlers for the tools the sync uses (design §9.2), each one
// a REST call on the fake Jira plus Rovo's own output conventions. Every shape Atlassian doesn't
// publish is decided in this file, so a recorded session that disagrees changes one place;
// fixtures/README.md ("The fake Rovo MCP server") lists them as ASSUMED with their sources.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { adfToHtml, adfToMarkdown, markdownToAdf, needsHtml } from "./markdown.js";
import { fieldsFor, findUser, issueTypeJson, statusJson, userJson, type RenderContext } from "./render.js";
import type { FakeJira, JiraReply } from "./server.js";
import type { Site } from "./site.js";

type Json = Record<string, unknown>;

interface Captured {
  serverInfo: Json;
  protocolVersion: string;
  primary: { name: string; description: string; inputSchema: Json; annotations: Json }[];
  operations: { name: string; product: string; executeTool: Runner; description: string; inputs: string[] }[];
}
type Runner = "executeRead" | "executeWrite" | "executeDestructive";

const CAPTURED = JSON.parse(readFileSync(join(import.meta.dirname, "..", "fixtures", "rovo-mcp-tools.json"), "utf8")) as Captured;

/** Rovo's constants and the wording of its errors (sources in fixtures/README.md). */
export const ROVO = {
  serverInfo: CAPTURED.serverInfo,
  protocolVersion: CAPTURED.protocolVersion,
  instructions: "Call getAccessibleAtlassianResources once per session and pass its cloudId to every tool.",
  /** `?tools=all` page size. ASSUMED: Atlassian documents only "paginated"; design §9.2 says 50. */
  pageSize: 50,
  /** The authorization server is a path-qualified issuer on the identity host (live metadata, 2026-10-24). */
  issuerPath: "/fake-rovo-issuer",
  paths: { authorize: "/authorize", token: "/oauth/token", register: "/fake-rovo-issuer/dcr/register", revoke: "/oauth/revoke" },
  /** Live `scopes_supported` has about 40; these are the ones a Jira client meets. */
  scopes: [
    "read:me", "read:account", "offline_access",
    "read:jira:agent-interface", "write:jira:agent-interface", "search:jira:agent-interface", "delete:jira:agent-interface", "manage:jira:agent-interface",
    "read:confluence:agent-interface", "write:confluence:agent-interface", "search:confluence:agent-interface", "search:rovo:agent-interface",
  ],
  /** `expires_in` of a live token (Team-Commonly capture, 2026-10-19). */
  accessTtlS: 28800,
  refreshIdleError: { error: "unauthorized_client", error_description: "refresh_token is invalid" },
  /** ASSUMED for the MCP endpoint: the body auth.atlassian.com sends with its 429s (#281). */
  rateLimited: { error: "too_many_requests", error_description: "Rate limit exceeded" },
  /** #283: what every Jira call answers while the grant is stale. */
  appNotInstalled: { code: 403, message: "The app is not installed on this instance" },
  sseGone: "The /v1/sse endpoint is no longer supported (since 2026-06-30). Use https://mcp.atlassian.com/v2/mcp.",
  /** "may consume up to 10 Rovo credits per call" (supported-tools page). Jira tools cost none. */
  searchCredits: 10,
};

export interface ToolResult { text: string; structured?: Json; isError?: boolean }

export interface ToolContext {
  jira: FakeJira;
  site: Site;
  /** False while the grant is stale (#283). */
  appInstalled: boolean;
  /** Scopes granted to the token (or the API token's scopes). */
  scopes: string[];
  catalogue: Catalogue;
}

export interface RovoTool {
  name: string;
  description: string;
  inputSchema: Json;
  annotations: Json;
  runner: Runner;
  credits: number;
  run(ctx: ToolContext, args: Json): ToolResult;
}

export interface Catalogue {
  /** The primary tools: what plain `/v2/mcp` lists. */
  primary: RovoTool[];
  /** Everything `?tools=all` lists, in order. */
  flat: RovoTool[];
  /** Every callable name (flat list plus primaries) → tool. */
  byName: Map<string, RovoTool>;
  /** `discover` + execute*: the operations reachable by name. */
  operations: Map<string, RovoTool>;
}

// ── Output conventions ───────────────────────────────────────────────────────────────────────

/** Text is one JSON block wrapped in `data` (#275); structuredContent mirrors it unless a tool says otherwise. */
const ok = (data: unknown, structured?: Json): ToolResult => ({ text: JSON.stringify({ data }), structured: structured ?? { data } });
/** Tool failures: `{"error":true,"message","statusCode"}` as text (#282, #178), with `isError` set (ASSUMED: reports differ). */
const fail = (statusCode: number, message: string): ToolResult => ({ text: JSON.stringify({ error: true, message, statusCode }), isError: true });
class Failure extends Error { constructor(readonly result: ToolResult) { super(result.text); } }
const bail = (statusCode: number, message: string): never => { throw new Failure(fail(statusCode, message)); };

/** One REST call on the fake Jira; a non-2xx answer becomes the tool's error. */
function rest(ctx: ToolContext, method: string, path: string, body?: unknown): unknown {
  const r: JiraReply = ctx.jira.invoke(method, path, body);
  if (r.status >= 200 && r.status < 300) return r.body;
  const b = (r.body ?? {}) as { errorMessages?: string[]; errors?: Record<string, string> };
  const parts = [...(b.errorMessages ?? []), ...Object.entries(b.errors ?? {}).map(([k, v]) => `${k}: ${v}`)];
  if (r.status === 404 && /\/issue\/([^/?]+)/.test(path) && /does not exist/.test(parts.join(" "))) bail(404, `Issue "${decodeURIComponent(/\/issue\/([^/?]+)/.exec(path)![1]!)}" not found`);
  if (r.status === 429) bail(429, "We are having trouble completing this action. Please try again shortly.");
  return bail(r.status, parts.join("; ") || `Jira answered ${r.status}`);
}
const enc = encodeURIComponent;
const qs = (o: Record<string, unknown>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

/** Rich text out: markdown unless asked for html or the body holds what markdown can't carry. */
function richText(adf: unknown, asked: unknown): { body: string; format: "markdown" | "html" } {
  if (adf === null || adf === undefined) return { body: "", format: "markdown" };
  // `adf` (or anything else) is not in the enum and is ignored: markdown it is (#189).
  return asked === "html" || needsHtml(adf) ? { body: adfToHtml(adf), format: "html" } : { body: adfToMarkdown(adf), format: "markdown" };
}

const webUrl = (site: Site, key: string) => `${site.baseUrl.replace(/\/$/, "")}/browse/${key}`;

/** getJiraIssue's compact view: a fixed set of keys, whatever `fields` names (#275, #256). */
const COMPACT = ["summary", "description", "status", "assignee", "priority", "updated", "attachment"];
/** Dropped from getJiraIssue in every view but `evidence` (#275: comments come from listJiraIssueComments). */
const NEVER = ["comment", "issuelinks"];

type View = "compact" | "evidence" | "full";

/**
 * A REST issue in Rovo's shape: rich text converted, `customfield_*` values moved under
 * `customFields` by field name (searchJiraIssuesUsingJql's `fields` description), and a per-issue
 * `appliedContentFormat`.
 */
function rovoIssue(ctx: ToolContext, raw: Json, keep: (fieldId: string) => boolean, format: unknown): Json {
  const fields = (raw.fields ?? {}) as Json;
  const out: Json = {};
  const custom: Json = {};
  let applied: "markdown" | "html" = "markdown";
  for (const [k, v] of Object.entries(fields)) {
    if (!keep(k) || v === undefined) continue;
    if (k === "description" || k === "environment") {
      const t = richText(v, format);
      if (t.format === "html") applied = "html";
      out[k] = v === null ? null : t.body;
    } else if (k.startsWith("customfield_")) {
      const f = ctx.site.fields.find((x) => x.id === k);
      custom[f?.name ?? k] = v;
    } else out[k] = v;
  }
  if (Object.keys(custom).length) out.customFields = custom;
  return { appliedContentFormat: applied, id: raw.id, key: raw.key, fields: out };
}

function viewOf(args: Json): View {
  return args.view === "evidence" || args.view === "full" ? args.view : "compact";
}

// ── Argument checks ──────────────────────────────────────────────────────────────────────────

/** Required inputs and JSON types from the tool's inputSchema; unknown inputs are dropped, as Rovo does. */
function checkArgs(tool: RovoTool, args: Json): Json {
  const props = (tool.inputSchema.properties ?? {}) as Record<string, { type?: string; enum?: unknown[] }>;
  const out: Json = {};
  for (const [k, v] of Object.entries(args)) {
    const p = props[k];
    if (!p || v === undefined) continue;
    const t = p.type;
    const okType = !t || (t === "array" ? Array.isArray(v) : t === "integer" ? Number.isInteger(v) : t === "object" ? typeof v === "object" && v !== null && !Array.isArray(v) : typeof v === t);
    if (!okType) bail(400, `Invalid input: ${k} must be ${t === "integer" ? "an integer" : `a${/^[aeiou]/.test(t!) ? "n" : ""} ${t}`}`);
    out[k] = v;
  }
  for (const k of (tool.inputSchema.required ?? []) as string[]) if (out[k] === undefined) bail(400, `Invalid input: ${k} is required`);
  return out;
}

/** `cloudId` takes the site UUID or its URL (inputSchema description); anything else is not this site. */
function checkCloud(ctx: ToolContext, args: Json) {
  const id = String(args.cloudId ?? "");
  const host = (s: string) => { try { return new URL(s.includes("://") ? s : `https://${s}`).host; } catch { return s; } };
  if (id === ctx.site.cloudId || host(id) === host(ctx.site.baseUrl)) return;
  bail(404, `No accessible Atlassian site matches cloudId "${id}". Call getAccessibleAtlassianResources to find it.`);
}

// ── Handlers ─────────────────────────────────────────────────────────────────────────────────

type Handler = (ctx: ToolContext, a: Json) => ToolResult;

const renderCtx = (ctx: ToolContext): RenderContext => ({ site: ctx.site, base: ctx.jira.gatewayUrl!, v: 3 });

function getIssue(ctx: ToolContext, a: Json): ToolResult {
  const view = viewOf(a);
  const asked = (a.fields as string[] | undefined) ?? [];
  const restFields = view === "compact" ? "*all" : asked.length ? asked.join(",") : "*all";
  const raw = rest(ctx, "GET", `/rest/api/3/issue/${enc(String(a.issueIdOrKey))}${qs({ fields: restFields, expand: a.expand, properties: (a.properties as string[] | undefined)?.join(",") })}`) as Json;
  const all = asked.length === 0 || asked.includes("*all");
  const keep = (k: string) => {
    if (k === "comment" || (k === "issuelinks" && view !== "evidence")) return false;
    if (view === "compact") return (COMPACT.includes(k) && (all || asked.includes(k))) || (k.startsWith("customfield_") && (all || asked.includes(k)));
    return true;
  };
  const issue = rovoIssue(ctx, raw, keep, a.responseContentFormat);
  if (raw.properties) issue.properties = raw.properties;
  // structuredContent: the search envelope with one node and its webUrl (#213, #118).
  return ok(issue, { issues: { nodes: [{ ...issue, webUrl: webUrl(ctx.site, String(raw.key)) }] } });
}

function searchPage(ctx: ToolContext, a: Json, jql: string, issues: Json[], next: string | undefined, isLast: boolean, total?: number): ToolResult {
  const asked = (a.fields as string[] | undefined) ?? [];
  const view = viewOf(a);
  const keep = (k: string) => k !== "comment" && (view === "evidence" || !k.startsWith("customfield_") || asked.includes(k));
  const rendered = issues.map((i) => rovoIssue(ctx, i, keep, a.responseContentFormat));
  const mode = a.searchResultMode ?? "issues";
  const data: Json = mode === "count" ? { total } : { issues: rendered, ...(next ? { nextPageToken: next } : {}), isLast, ...(mode === "all" ? { total } : {}) };
  return ok(data, {
    issues: {
      nodes: mode === "count" ? [] : rendered.map((i) => ({ ...i, webUrl: webUrl(ctx.site, String(i.key)) })),
      webUrl: `${ctx.site.baseUrl.replace(/\/$/, "")}/issues/?jql=${enc(jql)}`,
      pageInfo: { hasNextPage: !isLast, endCursor: next ?? null },
      // #118: totalCount counts the page, not the matches. ASSUMED still so.
      totalCount: rendered.length,
    },
  });
}

/** Search fields when none are named: the compact set (ASSUMED). */
const searchFields = (a: Json) => {
  const asked = (a.fields as string[] | undefined) ?? [];
  return viewOf(a) === "evidence" ? ["*all"] : asked.length ? asked : COMPACT;
};

function search(ctx: ToolContext, a: Json, jql: string): ToolResult {
  const maxResults = Math.min(Number(a.maxResults ?? 50), 100);
  const page = rest(ctx, "POST", "/rest/api/3/search/jql", { jql, fields: searchFields(a), maxResults, ...(a.nextPageToken ? { nextPageToken: a.nextPageToken } : {}) }) as { issues: Json[]; nextPageToken?: string; isLast: boolean };
  let total: number | undefined;
  if (a.searchResultMode === "count" || a.searchResultMode === "all") {
    // An approximate count: the fake's is exact.
    total = 0;
    for (let token: string | undefined, more = true; more;) {
      const p = rest(ctx, "POST", "/rest/api/3/search/jql", { jql, fields: ["id"], maxResults: 5000, ...(token ? { nextPageToken: token } : {}) }) as { issues: Json[]; nextPageToken?: string; isLast: boolean };
      total += p.issues.length;
      token = p.nextPageToken;
      more = !p.isLast;
    }
  }
  return searchPage(ctx, a, jql, page.issues, page.nextPageToken, page.isLast, total);
}

const board = (ctx: ToolContext, id: unknown) => ctx.site.boards.find((b) => String(b.id) === String(id)) ?? bail(404, `Board ${String(id)} not found`);
const withoutOrder = (jql: string) => jql.split(/\s+order\s+by\s+/i)[0]!;

/** Users, as the assignable-user and account lookups list them. */
const usersJson = (ctx: ToolContext, users: Site["users"]) => users.map((u) => userJson(renderCtx(ctx), u.accountId ?? null));
const matches = (u: Site["users"][number], q: unknown) => {
  const s = String(q ?? "").toLowerCase();
  return !s || u.displayName.toLowerCase().includes(s) || (u.emailAddress ?? "").toLowerCase().includes(s) || u.accountId === q;
};

function comments(ctx: ToolContext, a: Json): ToolResult {
  const page = rest(ctx, "GET", `/rest/api/3/issue/${enc(String(a.issueIdOrKey))}/comment${qs({ startAt: a.startAt, maxResults: a.maxResults, orderBy: a.orderBy, expand: a.expand })}`) as { comments: Json[] } & Json;
  return ok({ ...page, comments: page.comments.map((c) => commentOut(c, a.responseContentFormat)) });
}
function commentOut(c: Json, format: unknown): Json {
  const t = richText(c.body, format);
  return { ...c, body: t.body, appliedContentFormat: t.format };
}

/** The body a write takes: markdown (default) becomes ADF. ASSUMED: html bodies are refused by the fake. */
function bodyIn(a: Json, md: unknown): unknown {
  if (a.contentFormat === "html") bail(400, "The fake Rovo MCP server accepts markdown bodies only.");
  return markdownToAdf(String(md));
}

const issueRef = (a: Json) => enc(String(a.issueIdOrKey));

const HANDLERS: Record<string, Handler> = {
  getAccessibleAtlassianResources: (ctx) => {
    const host = new URL(ctx.site.baseUrl).host;
    const jiraScopes = ctx.scopes.filter((s) => s.includes(":jira:") || ["read:me", "read:account", "offline_access"].includes(s));
    const entry = { id: ctx.site.cloudId, url: ctx.site.baseUrl.replace(/\/$/, ""), name: host.split(".")[0], ...(ctx.appInstalled ? { scopes: jiraScopes } : {}), avatarUrl: `https://site-admin-avatar-cdn.prod.public.atl-paas.net/avatars/240/rocket.png` };
    // A bare array as text (#283); structuredContent has to be an object.
    return { text: JSON.stringify([entry]), structured: { resources: [entry] } };
  },
  atlassianUserInfo: (ctx) => {
    const me = findUser(ctx.site, ctx.site.myself)!;
    return ok({ account_id: me.accountId, email: me.emailAddress ?? null, name: me.displayName, picture: `https://avatar-management.example/${me.accountId}`, account_status: "active", nickname: me.displayName.split(" ")[0], zoneinfo: me.timeZone ?? ctx.site.serverInfo.serverTimeZone, locale: "en-US" });
  },
  getJiraCurrentUser: (ctx, a) => ok(rest(ctx, "GET", `/rest/api/3/myself${qs({ expand: a.expand })}`)),
  searchJiraIssuesUsingJql: (ctx, a) => search(ctx, a, String(a.jql)),
  getJiraIssue: getIssue,
  listJiraProjects: (ctx, a) => ok(rest(ctx, "GET", `/rest/api/3/project/search${qs({ query: a.query, startAt: a.startAt, maxResults: a.maxResults, expand: a.expand })}`)),
  listJiraStatuses: (ctx, a) => {
    // ASSUMED modes: the catalogue gives `mode` as a required string and nothing more.
    if (a.mode === "project") {
      if (!a.projectKey) bail(400, "Invalid input: projectKey is required when mode is project");
      const perType = rest(ctx, "GET", `/rest/api/3/project/${enc(String(a.projectKey))}/statuses`) as { name: string; statuses: Json[] }[];
      return ok(perType.filter((t) => !a.issueType || t.name === a.issueType || (t as Json).id === a.issueType));
    }
    if (a.mode !== "search") bail(400, `Invalid input: mode must be one of "project", "search"`);
    const c = renderCtx(ctx);
    const q = String(a.nameContains ?? "").toLowerCase();
    const hits = ctx.site.statuses.filter((s) => (!a.statusIdOrName || s.id === a.statusIdOrName || s.name.toLowerCase() === String(a.statusIdOrName).toLowerCase())
      && (!q || s.name.toLowerCase().includes(q)) && (!a.statusCategory || s.statusCategory.key === a.statusCategory || s.statusCategory.name === a.statusCategory));
    return ok({ statuses: hits.map((s) => statusJson(c, s)) });
  },
  listJiraIssueTransitions: (ctx, a) => ok(rest(ctx, "GET", `/rest/api/3/issue/${issueRef(a)}/transitions${qs({ transitionId: a.transitionId, expand: a.expand, includeUnavailableTransitions: a.includeUnavailableTransitions })}`)),
  transitionJiraIssue: (ctx, a) => {
    if (a.sprintId !== undefined || a.assignToBacklog) bail(501, "The fake Rovo MCP server does not move issues between sprints.");
    let id = a.transitionId as string | undefined;
    if (id === undefined && a.transitionName === undefined) bail(400, "Invalid input: provide transitionId or transitionName, or a sprintId / assignToBacklog");
    const list = (rest(ctx, "GET", `/rest/api/3/issue/${issueRef(a)}/transitions`) as { transitions: { id: string; name: string }[] }).transitions;
    if (id === undefined) {
      id = list.find((t) => t.name.toLowerCase() === String(a.transitionName).toLowerCase())?.id
        ?? bail(400, `Transition "${String(a.transitionName)}" is not available for this issue. Available: ${list.map((t) => t.name).join(", ")}`);
    }
    rest(ctx, "POST", `/rest/api/3/issue/${issueRef(a)}/transitions`, { transition: { id }, ...(a.fields ? { fields: a.fields } : {}), ...(a.update ? { update: a.update } : {}), ...(a.historyMetadata ? { historyMetadata: a.historyMetadata } : {}) });
    const after = rest(ctx, "GET", `/rest/api/3/issue/${issueRef(a)}?fields=status`) as { key: string; fields: { status: Json } };
    // ASSUMED shape: the docs only say it reports where the issue landed.
    return ok({ key: after.key, transition: { id, name: list.find((t) => t.id === id)?.name ?? null }, status: after.fields.status });
  },
  listJiraIssueComments: comments,
  addOrEditJiraIssueComment: (ctx, a) => {
    if (typeof a.commentBody !== "string" || a.commentBody.trim() === "") bail(400, "Invalid input: commentBody is required");
    const body = { body: bodyIn(a, a.commentBody), ...(a.commentVisibility ? { visibility: a.commentVisibility } : {}) };
    const c = a.commentId
      ? rest(ctx, "PUT", `/rest/api/3/issue/${issueRef(a)}/comment/${enc(String(a.commentId))}`, body)
      : rest(ctx, "POST", `/rest/api/3/issue/${issueRef(a)}/comment`, body);
    return ok(commentOut(c as Json, a.responseContentFormat));
  },
  listJiraIssueChangelogs: (ctx, a) => ok(rest(ctx, "GET", `/rest/api/3/issue/${issueRef(a)}/changelog${qs({ startAt: a.startAt, maxResults: a.maxResults })}`)),
  listJiraBoards: (ctx, a) => ok(rest(ctx, "GET", `/rest/agile/1.0/board${qs({ projectKeyOrId: a.projectKeyOrId, type: a.type, name: a.name, startAt: a.startAt, maxResults: a.maxResults })}`)),
  getJiraBoardConfig: (ctx, a) => ok(rest(ctx, "GET", `/rest/agile/1.0/board/${enc(String(a.boardId))}/configuration`)),
  listJiraBoardSprints: (ctx, a) => ok(rest(ctx, "GET", `/rest/agile/1.0/board/${enc(String(a.boardId))}/sprint${qs({ state: a.state, startAt: a.startAt, maxResults: a.maxResults })}`)),
  getJiraBoardIssueData: (ctx, a) => {
    const b = board(ctx, a.boardId);
    // ASSUMED datasets: the board's issues (its filter) or its backlog.
    if (a.dataset === "backlog") {
      const page = rest(ctx, "GET", `/rest/software/1.0/board/${b.id}/backlog${qs({ jql: a.jql, maxResults: Math.min(Number(a.maxResults ?? 50), 100), nextPageToken: a.nextPageToken, fields: searchFields(a).join(",") })}`) as { issues: Json[]; nextPageToken?: string; isLast: boolean };
      return searchPage(ctx, a, b.filter.jql, page.issues, page.nextPageToken, page.isLast);
    }
    if (a.dataset !== undefined && a.dataset !== "board") bail(400, `Invalid input: dataset must be one of "board", "backlog"`);
    const order = /\s+order\s+by\s+(.*)$/i.exec(b.filter.jql)?.[1];
    const jql = `(${withoutOrder(b.filter.jql)})${a.jql ? ` AND (${withoutOrder(String(a.jql))})` : ""}${order ? ` ORDER BY ${order}` : ""}`;
    return search(ctx, a, jql);
  },
  getJiraBoardSprintData: (ctx, a) => {
    const proj = a.projectKeyOrId ? String(a.projectKeyOrId).toUpperCase() : undefined;
    const b = a.boardId !== undefined ? board(ctx, a.boardId)
      : ctx.site.boards.find((x) => (!a.boardName || x.name === a.boardName) && (!proj || x.projectKey === proj || ctx.site.projects.find((p) => p.key === x.projectKey)?.id === proj) && (!a.boardType || x.type === a.boardType))
        ?? bail(404, "No board matches");
    if (b.type !== "scrum") bail(400, `Board ${b.id} is a ${b.type} board and has no sprints`);
    const sprints = ctx.site.sprints.filter((s) => s.boardId === b.id);
    const s = a.sprintId !== undefined ? sprints.find((x) => String(x.id) === String(a.sprintId))
      : a.sprintName !== undefined ? sprints.find((x) => x.name === a.sprintName)
      : sprints.find((x) => x.state === "active");
    if (!s) return bail(404, a.sprintId === undefined && a.sprintName === undefined ? `Board ${b.id} has no active sprint` : "Sprint not found");
    const sprint = rest(ctx, "GET", `/rest/agile/1.0/sprint/${s.id}`) as Json;
    const data: Json = { board: { id: b.id, name: b.name, type: b.type }, sprint };
    if (a.includeIssues) {
      const page = JSON.parse(search(ctx, { maxResults: 100 }, `sprint = ${s.id} ORDER BY Rank ASC`).text) as { data: { issues: Json[] } };
      data.issues = page.data.issues;
    }
    return ok(data);
  },
  getJiraIssueTypeMetaWithFields: (ctx, a) => {
    const p = ctx.site.projects.find((x) => x.key === String(a.projectIdOrKey).toUpperCase() || x.id === a.projectIdOrKey) ?? bail(404, `Project ${String(a.projectIdOrKey)} not found`);
    if (!p.issueTypes.some((t) => t.id === String(a.issueTypeId))) bail(404, `Issue type ${String(a.issueTypeId)} is not in project ${p.key}`);
    const required = new Set(["summary", "issuetype", "project", "reporter"]);
    const all = fieldsFor(ctx.site, p.id)
      .filter((f) => !["status", "updated", "created", "comment", "subtasks", "resolution", "attachment"].includes(f.id))
      .map((f) => ({ fieldId: f.id, key: f.id, name: f.name, required: required.has(f.id), schema: f.schema, hasDefaultValue: f.id === "priority", operations: f.multi ? ["add", "set", "remove"] : ["set"] }))
      .filter((f) => !a.requiredFieldsOnly || f.required);
    const startAt = Number(a.startAt ?? 0), maxResults = Number(a.maxResults ?? 50);
    return ok({ startAt, maxResults, total: all.length, fields: all.slice(startAt, startAt + maxResults) });
  },
  listJiraProjectIssueTypesMetadata: (ctx, a) => {
    const p = ctx.site.projects.find((x) => x.key === String(a.projectIdOrKey).toUpperCase() || x.id === a.projectIdOrKey) ?? bail(404, `Project ${String(a.projectIdOrKey)} not found`);
    const all = p.issueTypes.map((t) => issueTypeJson(renderCtx(ctx), p, t));
    const startAt = Number(a.startAt ?? 0), maxResults = Number(a.maxResults ?? 50);
    return ok({ startAt, maxResults, total: all.length, issueTypes: all.slice(startAt, startAt + maxResults) });
  },
  listJiraIssueAssignableUsers: (ctx, a) => {
    if (!a.project && !a.issueKey) bail(400, "Invalid input: project or issueKey is required");
    const key = a.issueKey ? (rest(ctx, "GET", `/rest/api/3/issue/${enc(String(a.issueKey))}?fields=project`) as { fields: { project: { key: string } } }).fields.project.key : String(a.project).toUpperCase();
    const assignableSelf = ctx.site.permissions[key]?.includes("ASSIGNABLE_USER") ?? false;
    return ok(usersJson(ctx, ctx.site.users.filter((u) => u.active && matches(u, a.query) && (u.accountId !== ctx.site.myself || assignableSelf))));
  },
  lookupJiraAccountId: (ctx, a) => ok(usersJson(ctx, ctx.site.users.filter((u) => matches(u, a.query)).slice(0, Number(a.maxResults ?? 50)))),
  editJiraIssue: (ctx, a) => {
    const fields = { ...(a.fields as Json | undefined), ...(a.additional_fields as Json | undefined) };
    if (Object.keys(fields).length === 0) bail(400, "Invalid input: fields is required");
    if ("description" in fields && fields.description !== null) fields.description = bodyIn(a, fields.description);
    rest(ctx, "PUT", `/rest/api/3/issue/${issueRef(a)}`, { fields });
    return getIssue(ctx, { issueIdOrKey: a.issueIdOrKey, responseContentFormat: a.responseContentFormat });
  },
  createJiraIssueRemoteIssueLink: (ctx, a) => {
    // No globalId input: Rovo can't upsert a link, only add one (the catalogue's inputs).
    const object = { url: a.url, title: a.title ?? a.url, ...(a.summary ? { summary: a.summary } : {}) };
    return ok(rest(ctx, "POST", `/rest/api/3/issue/${issueRef(a)}/remotelink`, { object, ...(a.relationship ? { relationship: a.relationship } : {}) }));
  },
  listJiraIssueRemoteIssueLinks: (ctx, a) => {
    const raw = rest(ctx, "GET", `/rest/api/3/issue/${issueRef(a)}/remotelink${qs({ globalId: a.globalId })}`);
    // ASSUMED from one third-party report: links come back without their globalId.
    const strip = ({ globalId: _g, self: _s, ...l }: Json) => l;
    return ok(Array.isArray(raw) ? (raw as Json[]).map(strip) : [strip(raw as Json)]);
  },
  getJiraEntityProperty: (ctx, a) => {
    if (a.entityType !== "issue") bail(501, `The fake Rovo MCP server has properties on issues only, not ${String(a.entityType)}`);
    if (!a.issueIdOrKey) bail(400, "Invalid input: issueIdOrKey is required for entityType issue");
    if (a.propertyKey === undefined) return ok({ keys: (rest(ctx, "GET", `/rest/api/3/issue/${issueRef(a)}/properties`) as { keys: { key: string }[] }).keys.map((k) => ({ key: k.key })) });
    return ok(rest(ctx, "GET", `/rest/api/3/issue/${issueRef(a)}/properties/${enc(String(a.propertyKey))}`));
  },
  editJiraEntityProperty: (ctx, a) => {
    if (a.entityType !== "issue") bail(501, `The fake Rovo MCP server has properties on issues only, not ${String(a.entityType)}`);
    if (!a.issueIdOrKey) bail(400, "Invalid input: issueIdOrKey is required for entityType issue");
    rest(ctx, "PUT", `/rest/api/3/issue/${issueRef(a)}/properties/${enc(String(a.propertyKey))}`, a.value);
    return ok({ key: a.propertyKey, value: a.value });
  },
  getJiraWorkflows: (ctx, a) => {
    const p = a.projectIdOrKey ? ctx.site.projects.find((x) => x.key === String(a.projectIdOrKey).toUpperCase() || x.id === a.projectIdOrKey) : undefined;
    const pairs = p ? p.issueTypes.filter((t) => !a.issueTypeId || t.id === a.issueTypeId).map((t) => ({ projectId: p.id, issueTypeId: t.id })) : [];
    return ok(rest(ctx, "POST", "/rest/api/3/workflows", { workflowNames: a.workflowNames ?? [], projectAndIssueTypes: pairs }));
  },
  search: (ctx, a) => {
    // Rovo semantic search, stood in for by words of the query in the summary. Costs credits.
    const words = String(a.query).toLowerCase().split(/\s+/).filter(Boolean);
    const hits = ctx.site.issues.filter((i) => !i.restricted && !i.deleted && words.some((w) => i.summary.toLowerCase().includes(w))).slice(0, Number(a.limit ?? 10));
    const results = hits.map((i) => ({ id: `ari:cloud:jira:${ctx.site.cloudId}:issue/${i.id}`, title: `${i.key}: ${i.summary}`, url: webUrl(ctx.site, i.key), type: "issue", lastModified: i.updated }));
    return ok({ results }, { results });
  },
};

// ── Shapes for tools the captures don't have (GH#282: listJiraBoards and listJiraBoardSprints are
// on the supported-tools page but missing from some sites' catalogues; getJiraWorkflows is in the
// manage_jira group, off by default). All ASSUMED. ──────────────────────────────────────────────
const EXTRA: Captured["operations"] = [
  { name: "listJiraBoards", product: "jira", executeTool: "executeRead", description: "List the boards on a Jira site, optionally for one project.", inputs: ["cloudId*:string", "projectKeyOrId:string", "type:string", "name:string", "startAt:number", "maxResults:number"] },
  { name: "listJiraBoardSprints", product: "jira", executeTool: "executeRead", description: "List the sprints of a Scrum board.", inputs: ["cloudId*:string", "boardId*:number", "state:string", "startAt:number", "maxResults:number"] },
];
const MANAGE: Captured["operations"] = [
  { name: "getJiraWorkflows", product: "jira", executeTool: "executeRead", description: "Read workflows: statuses and transitions (requires manage_jira).", inputs: ["cloudId*:string", "workflowNames:array", "projectIdOrKey:string", "issueTypeId:string"] },
];
/** Names from before CHANGE-3452, answered when `oldNames` is on. */
const OLD_NAMES: Record<string, string> = { findJiraIssueAssignableUsers: "listJiraIssueAssignableUsers" };

// ── The catalogue ────────────────────────────────────────────────────────────────────────────

const schemaOf = (inputs: string[]): Json => {
  const properties: Json = {};
  const required: string[] = [];
  for (const spec of inputs) {
    const [n, type] = spec.split(":") as [string, string];
    const name = n.replace(/\*$/, "");
    if (n.endsWith("*")) required.push(name);
    properties[name] = type === "any" ? {} : type === "array" ? { type, items: {} } : type === "object" ? { type, additionalProperties: {} } : { type };
  }
  return { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties, required, additionalProperties: false };
};

const NO_CLOUD_ID = new Set(["getAccessibleAtlassianResources", "atlassianUserInfo", "discover", "executeRead", "executeWrite", "executeDestructive"]);
const NO_GRANT_NEEDED = new Set(["getAccessibleAtlassianResources", "atlassianUserInfo", "discover"]);

function makeTool(name: string, description: string, inputSchema: Json, annotations: Json, runner: Runner, handler: Handler | undefined): RovoTool {
  const tool: RovoTool = {
    name, description, inputSchema, annotations, runner,
    credits: name === "search" ? ROVO.searchCredits : 0,
    run(ctx, raw) {
      try {
        if (!ctx.appInstalled && !NO_GRANT_NEEDED.has(name)) return { text: JSON.stringify(ROVO.appNotInstalled), isError: true };
        const args = checkArgs(tool, raw);
        if (!NO_CLOUD_ID.has(name)) checkCloud(ctx, args);
        if (!handler) return fail(501, `The fake Rovo MCP server does not implement ${name}.`);
        return handler(ctx, args);
      } catch (e) {
        if (e instanceof Failure) return e.result;
        throw e;
      }
    },
  };
  return tool;
}

const runnerOf = (annotations: Json): Runner => (annotations.readOnlyHint ? "executeRead" : annotations.destructiveHint ? "executeDestructive" : "executeWrite");

export function toolCatalogue(o: { manageJira: boolean; oldNames: boolean; unavailable: string[] }): Catalogue {
  const operations = new Map<string, RovoTool>();
  const primary: RovoTool[] = [];
  const opTool = (op: Captured["operations"][number], name = op.name, handler = HANDLERS[op.name]) =>
    makeTool(name, op.description, schemaOf(op.inputs), { title: name, readOnlyHint: op.executeTool === "executeRead", destructiveHint: op.executeTool === "executeDestructive", idempotentHint: op.executeTool === "executeRead", openWorldHint: false }, op.executeTool, handler);

  for (const t of CAPTURED.primary) {
    const meta = META[t.name];
    primary.push(makeTool(t.name, t.description, t.inputSchema, t.annotations, runnerOf(t.annotations), meta ? (ctx, a) => meta(ctx, a, catalogue) : HANDLERS[t.name]));
  }
  const ops = [...CAPTURED.operations, ...EXTRA, ...(o.manageJira ? MANAGE : [])].filter((op) => !o.unavailable.includes(op.name));
  for (const op of ops) operations.set(op.name, opTool(op));
  for (const t of primary) if (!META[t.name]) operations.set(t.name, t);
  const flat = [...primary, ...ops.filter((op) => !primary.some((t) => t.name === op.name)).map((op) => operations.get(op.name)!)];
  if (o.oldNames) {
    for (const [old, now] of Object.entries(OLD_NAMES)) {
      const op = ops.find((x) => x.name === now);
      if (op) { const t = opTool(op, old, HANDLERS[now]); flat.push(t); operations.set(old, t); }
    }
  }
  const byName = new Map([...flat, ...primary].map((t) => [t.name, t]));
  const catalogue: Catalogue = { primary, flat, byName, operations };
  return catalogue;
}

// ── discover / execute* ──────────────────────────────────────────────────────────────────────

type Meta = (ctx: ToolContext, a: Json, catalogue: Catalogue) => ToolResult;

const META: Record<string, Meta> = {
  /** One JSON line with up to 5 full results, then the other names as plain text (#282; atl-cli). */
  discover: (_ctx, a, catalogue) => {
    const words = String(a.query).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const scored = [...catalogue.operations.values()]
      .map((t) => ({ t, score: words.filter((w) => t.name.toLowerCase().includes(w) || t.description.toLowerCase().includes(w)).length }))
      .filter((x) => x.score > 0)
      .sort((x, y) => y.score - x.score || x.t.name.localeCompare(y.t.name));
    const results = scored.slice(0, 5).map(({ t }) => ({
      name: t.name, product: "jira", executeTool: t.runner, description: t.description,
      inputs: Object.entries((t.inputSchema.properties ?? {}) as Record<string, { type?: string }>).map(([name, p]) => ({ name, type: p.type ?? "any", required: ((t.inputSchema.required ?? []) as string[]).includes(name) })),
    }));
    const more = scored.slice(5).map(({ t }) => t.name);
    const head = JSON.stringify({ results, searchableCount: catalogue.operations.size, totalCatalogSize: catalogue.operations.size });
    return { text: more.length ? `${head}\nAlso matched: ${more.join(", ")}` : head, structured: { results, searchableCount: catalogue.operations.size, totalCatalogSize: catalogue.operations.size } };
  },
  executeRead: (ctx, a, c) => execute(ctx, a, c, "executeRead"),
  executeWrite: (ctx, a, c) => execute(ctx, a, c, "executeWrite"),
  executeDestructive: (ctx, a, c) => execute(ctx, a, c, "executeDestructive"),
};

function execute(ctx: ToolContext, a: Json, catalogue: Catalogue, runner: Runner): ToolResult {
  const name = String(a.name);
  const op = catalogue.operations.get(name);
  if (!op) return fail(400, `Unknown operation "${name}". Use discover to find valid operation names.`);
  if (op.runner !== runner) return fail(400, `Operation "${name}" must be run with ${op.runner}, not ${runner}.`);
  // cloudId goes at the top level, never inside inputs (the execute tools' descriptions).
  return op.run(ctx, { ...(a.inputs as Json | undefined), cloudId: a.cloudId, ...(a.view ? { view: a.view } : {}) });
}
