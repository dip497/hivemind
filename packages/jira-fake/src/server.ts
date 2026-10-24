// The fake Jira: an HTTP server that answers the sync's REST calls from a live, mutable copy of a
// fixture site (design §15). Transitions, assignments, comments, remote links and properties change
// the model, so later reads see them. Behaviour follows Atlassian's OpenAPI specs and the P-R
// findings in design §18; fixtures/README.md ("The fake server") says how a test uses it.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { compileJql, JqlSyntaxError, parseJql, type JqlNode, type JqlQuery } from "./jql.js";
import {
  commentJson, fieldsFor, findUser, historyJson, issueJson, issueTypeJson, projectRefJson, selectFields,
  statusJson, textToAdf, userJson, userRef, type IssueRenderOptions, type RenderContext,
} from "./render.js";
import type { Site, SiteIssue, SiteTransition } from "./site.js";
import { formatJiraTime } from "./time.js";

type Json = Record<string, unknown>;
type Fault = Site["faults"][number];

export interface FakeJiraCredentials {
  /** Atlassian account email for Cloud Basic auth (classic and scoped tokens). */
  email: string;
  /** Classic (unscoped) API token: accepted on the site URL only. */
  classicToken: string;
  /** Scoped API token: accepted only under `/ex/jira/{cloudId}`; the site URL answers 401. */
  scopedToken: string;
  /** The scoped token's scopes. Omitted = everything. Agile endpoints need a granular `…:jira-software` scope. */
  scopes?: string[];
  /** Data Center personal access token, sent as `Authorization: Bearer <pat>`. */
  pat: string;
}

export interface WriteWindow { max: number; windowMs: number }

export interface FakeJiraOptions {
  credentials?: Partial<FakeJiraCredentials>;
  /** The clock: `updated` stamps, relative JQL dates, rate-limit windows. Default: the real clock. */
  now?: () => Date;
  /** Admin rights: `statuses/search` and `POST /workflows` answer instead of 401. */
  admin?: boolean;
  /** Whether an entity-property write bumps `updated`. Unknown in real Jira (design §8.1). */
  propertyBumpsUpdated?: boolean;
  /** Per-issue write limit: `true` = Jira's 20 per 2 s and 100 per 30 s, or your own windows. */
  perIssueWriteLimit?: boolean | WriteWindow[];
  /** Per-issue caps (413 past them). Defaults: 5000 comments, 2000 remote links. */
  limits?: { comments?: number; remoteLinks?: number };
  /** Bulkfetch reports these ids/keys in `issueErrors[]` instead of returning them (retriable failures). */
  issueErrors?: Record<string, string>;
  /** Search shows an issue as it was before a write for this long, unless `reconcileIssues` names it. */
  searchLagMs?: number;
  port?: number;
}

export interface LoggedRequest {
  method: string;
  /** Path without the `/ex/jira/{cloudId}` prefix and without the query. */
  path: string;
  query: URLSearchParams;
  body: unknown;
  via: "site" | "gateway";
  status: number;
}

export interface FakeJira {
  /** The site URL (`http://127.0.0.1:<port>`). Classic tokens and Data Center PATs go here. */
  url: string;
  /** `<url>/ex/jira/<cloudId>` on Cloud, where scoped tokens go. */
  gatewayUrl: string | undefined;
  /** The live model. Read it to assert on writes; mutate it to simulate someone else's change. */
  site: Site;
  requests: LoggedRequest[];
  credentials: FakeJiraCredentials;
  /** The Authorization header value for a credential kind (default: classic on Cloud, PAT on DC). */
  authorization(kind?: "classic" | "scoped" | "pat"): string;
  /**
   * Answers one REST call in-process, as the gateway would for an authorised caller: faults and
   * write limits apply, `requests` doesn't log it. The fake Rovo MCP server reads and writes
   * through this, so both transports see one Jira.
   */
  invoke(method: string, pathAndQuery: string, body?: unknown): JiraReply;
  close(): Promise<void>;
}

export interface JiraReply { status: number; body: unknown; headers: Record<string, string> }

const PERMISSION_NAMES: Record<string, string> = {
  BROWSE_PROJECTS: "Browse Projects", TRANSITION_ISSUES: "Transition Issues", ASSIGN_ISSUES: "Assign Issues", ASSIGNABLE_USER: "Assignable User",
  ADD_COMMENTS: "Add Comments", EDIT_ISSUES: "Edit Issues", LINK_ISSUES: "Link Issues", CREATE_ISSUES: "Create Issues",
};
const PERMISSION_IDS: Record<string, string> = {
  BROWSE_PROJECTS: "10", CREATE_ISSUES: "11", EDIT_ISSUES: "12", ASSIGN_ISSUES: "13", ASSIGNABLE_USER: "17", ADD_COMMENTS: "15", LINK_ISSUES: "21", TRANSITION_ISSUES: "46",
};
const OLD_SEARCH_GONE = "The requested API has been removed. Please migrate to the /rest/api/3/search/jql API. A full migration guideline is available at https://developer.atlassian.com/changelog/#CHANGE-2046";
const NO_ISSUE = "Issue does not exist or you do not have permission to see it.";
/** CHANGE-3193: the Agile issue listings stop answering after this instant. */
const AGILE_LISTINGS_REMOVED = Date.UTC(2026, 10, 2);

class Reply {
  constructor(readonly status: number, readonly body?: unknown, readonly headers: Record<string, string> = {}, readonly text = false) {}
  with(headers: Record<string, string>): Reply { return new Reply(this.status, this.body, { ...this.headers, ...headers }, this.text); }
}
const json = (status: number, body: unknown, headers?: Record<string, string>) => new Reply(status, body, headers);
const empty = (status: number) => new Reply(status);
const errors = (status: number, errorMessages: string[], errs: Record<string, string> = {}) => json(status, { errorMessages, errors: errs });

export async function createFakeJira(input: Site, opts: FakeJiraOptions = {}): Promise<FakeJira> {
  const site: Site = structuredClone(input);
  const now = () => (opts.now ? opts.now().getTime() : Date.now());
  const me = findUser(site, site.myself)!;
  const creds: FakeJiraCredentials = {
    email: me.emailAddress ?? "fake@example.com",
    classicToken: "fake-classic-token",
    scopedToken: "fake-scoped-token",
    pat: "fake-pat",
    ...opts.credentials,
  };
  const isCloud = site.deployment === "Cloud";
  const requests: LoggedRequest[] = [];
  const faultHits = new WeakMap<Fault, number>();
  const writes = new Map<string, number[]>();
  const stale = new Map<string, { copy: SiteIssue; until: number }>();
  const writeWindows: WriteWindow[] = opts.perIssueWriteLimit === true
    ? [{ max: 20, windowMs: 2_000 }, { max: 100, windowMs: 30_000 }]
    : Array.isArray(opts.perIssueWriteLimit) ? opts.perIssueWriteLimit : [];
  const limits = { comments: 5000, remoteLinks: 2000, ...opts.limits };
  let nextId = 900_000;
  const newId = () => String(nextId++);

  // ── Model helpers ────────────────────────────────────────────────────────────────────────

  const can = (projectKey: string, perm: string) => site.permissions[projectKey]?.includes(perm) ?? false;
  const visible = (i: SiteIssue) => !i.restricted && !i.deleted && can(i.project, "BROWSE_PROJECTS");
  const lookup = (idOrKey: string) => {
    const up = idOrKey.toUpperCase();
    return site.issues.find((i) => i.id === idOrKey) ?? site.issues.find((i) => i.key === up) ?? site.issues.find((i) => i.previousKeys.includes(up));
  };
  const findIssue = (idOrKey: string) => { const i = lookup(idOrKey); return i && visible(i) ? i : undefined; };
  const projectOf = (i: SiteIssue) => site.projects.find((p) => p.key === i.project)!;
  const findProject = (idOrKey: string) => site.projects.find((p) => p.id === idOrKey || p.key.toUpperCase() === idOrKey.toUpperCase() || p.projectKeys?.includes(idOrKey.toUpperCase()));
  const workflowOf = (i: SiteIssue) => site.workflows[projectOf(i).issueTypes.find((t) => t.id === i.issueType)!.workflow]!;
  const statusById = (id: string) => site.statuses.find((s) => s.id === id)!;
  const meRef = site.myself;
  const timeZone = me.timeZone ?? site.serverInfo.serverTimeZone;

  const touch = (i: SiteIssue) => { i.updated = formatJiraTime(now()); };
  const remember = (i: SiteIssue) => {
    if (!opts.searchLagMs) return;
    const s = stale.get(i.id);
    if (!s || s.until <= now()) stale.set(i.id, { copy: structuredClone(i), until: now() + opts.searchLagMs });
  };
  const history = (i: SiteIssue, items: SiteIssue["changelog"][number]["items"]) => {
    i.changelog.push({ id: newId(), author: meRef, created: formatJiraTime(now()), items });
  };
  /** The per-issue write limit: a 429 when this write would exceed a window, else records the write. */
  const writeGate = (i: SiteIssue): Reply | undefined => {
    if (writeWindows.length === 0) return undefined;
    const t = now();
    const log = (writes.get(i.id) ?? []).filter((w) => t - w < Math.max(...writeWindows.map((x) => x.windowMs)));
    for (const w of writeWindows) {
      const inWindow = log.filter((x) => t - x < w.windowMs);
      if (inWindow.length >= w.max) {
        const retry = Math.max(1, Math.ceil((inWindow[0]! + w.windowMs - t) / 1000));
        return errors(429, ["Too many write requests to this issue."], {}).with({ "Retry-After": String(retry), "RateLimit-Reason": "jira-per-issue-on-write" });
      }
    }
    log.push(t);
    writes.set(i.id, log);
    return undefined;
  };

  const transitionCandidates = (i: SiteIssue) => workflowOf(i).transitions.filter((t) => (t.from === "*" ? t.to !== i.status : t.from.includes(i.status)));
  const conditionMet = (t: SiteTransition, i: SiteIssue) =>
    !t.condition || (t.condition.kind === "assigneeOnly" ? i.assignee === meRef : t.condition.allow.includes(meRef));
  const transitionJson = (c: RenderContext, i: SiteIssue, t: SiteTransition, withFields: boolean): Json => {
    const base: Json = { id: t.id, name: t.name, to: statusJson(c, statusById(t.to)) };
    if (isCloud) Object.assign(base, { hasScreen: t.hasScreen, isGlobal: t.from === "*", isInitial: false, isAvailable: conditionMet(t, i), isConditional: !!t.condition, isLooped: false });
    if (withFields) {
      base.fields = Object.fromEntries(Object.entries(t.fields).map(([key, f]) => [key, {
        required: f.required, schema: f.schema, name: f.name, key, hasDefaultValue: f.hasDefaultValue, operations: f.operations,
        ...(f.allowedValues ? { allowedValues: f.allowedValues.map((v) => ({ self: `${c.base}/rest/api/${c.v}/${key}/${v.id}`, ...v })) } : {}),
      }]));
    }
    return base;
  };
  const listTransitions = (c: RenderContext, i: SiteIssue, q: URLSearchParams) => {
    if (!can(i.project, "TRANSITION_ISSUES")) return [];
    const includeUnavailable = isCloud && q.get("includeUnavailableTransitions") === "true";
    const withFields = (q.get("expand") ?? "").split(",").includes("transitions.fields");
    const id = q.get("transitionId");
    return transitionCandidates(i)
      .filter((t) => (includeUnavailable || conditionMet(t, i)) && (!id || t.id === id))
      .map((t) => transitionJson(c, i, t, withFields));
  };

  // ── Search helpers ───────────────────────────────────────────────────────────────────────

  const jqlContext = () => ({ site, me: meRef, timeZone, now: now() });
  const encodeToken = (o: Json) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const decodeToken = (t: string): Json | undefined => { try { return JSON.parse(Buffer.from(t, "base64url").toString()) as Json; } catch { return undefined; } };
  const searchIssues = (q: JqlQuery, reconcile: Set<string>) => {
    const compiled = compileJql(q, jqlContext());
    const t = now();
    const view = (i: SiteIssue) => { const s = stale.get(i.id); return s && s.until > t && !reconcile.has(i.id) ? s.copy : i; };
    const hits = site.issues.filter(visible).map(view).filter((i) => compiled.matches(i)).sort(compiled.compare);
    return { hits, errors: compiled.errors };
  };
  const parseOr400 = (jql: string): JqlQuery | Reply => {
    try { return parseJql(jql); } catch (e) { if (e instanceof JqlSyntaxError) return errors(400, [e.message]); throw e; }
  };
  const list = (q: URLSearchParams, name: string) => q.getAll(name).flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
  const renderOptions = (fields: string[] | undefined, dflt: "id" | "*navigable" | "*all", expand: string[], properties: string[], embedCaps: boolean, c: RenderContext): IssueRenderOptions => ({
    fields: selectFields(fields, dflt, site),
    expand: new Set(expand),
    properties,
    embedCaps,
    visible,
    transitions: (i) => listTransitions(c, i, new URLSearchParams()),
  });

  // ── Routes ───────────────────────────────────────────────────────────────────────────────

  type Ctx = { c: RenderContext; q: URLSearchParams; body: unknown; raw: string; p: Record<string, string> };
  type Handler = (x: Ctx) => Reply;
  const routes: { method: string; re: RegExp; keys: string[]; versions: (2 | 3)[]; cloudOnly?: boolean; dcOnly?: boolean; h: Handler }[] = [];
  const route = (method: string, pattern: string, h: Handler, o: { cloudOnly?: boolean; dcOnly?: boolean; versions?: (2 | 3)[] } = {}) => {
    const keys: string[] = [];
    const re = new RegExp(`^${pattern.replace("{v}", "(?<v>[23])").replace(/:(\w+)/g, (_, k: string) => { keys.push(k); return `(?<${k}>[^/]+)`; })}$`);
    routes.push({ method, re, keys, versions: o.versions ?? [2, 3], cloudOnly: o.cloudOnly, dcOnly: o.dcOnly, h });
  };
  const withIssue = (h: (x: Ctx, i: SiteIssue) => Reply): Handler => (x) => {
    const i = findIssue(x.p.key!);
    return i ? h(x, i) : errors(404, [NO_ISSUE]);
  };

  // Identity and discovery
  route("GET", "/rest/api/{v}/myself", ({ c }) => {
    const u = userJson(c, meRef)!;
    return json(200, { ...u, self: isCloud ? `${c.base}/rest/api/${c.v}/user?accountId=${me.accountId}` : `${c.base}/rest/api/2/user?username=${me.name}`, locale: "en_US", groups: { size: 0, items: [] }, applicationRoles: { size: 1, items: [] }, expand: "groups,applicationRoles", ...(isCloud ? {} : { deleted: false }) });
  });
  route("GET", "/rest/api/{v}/serverInfo", ({ c }) => json(200, {
    // The site's own URL, also when asked through the gateway.
    baseUrl: isCloud ? site.baseUrl.replace(/\/$/, "") : c.base, version: site.serverInfo.version, versionNumbers: site.serverInfo.versionNumbers,
    ...(isCloud ? { deploymentType: "Cloud" } : {}),
    buildNumber: site.serverInfo.buildNumber, buildDate: "2026-10-01T00:00:00.000+0000", serverTime: formatJiraTime(now()),
    scmInfo: "0000000000000000000000000000000000000000", serverTitle: "Jira", serverTimeZone: site.serverInfo.serverTimeZone,
  }));
  const projectJson = (c: RenderContext, p: Site["projects"][number], expand: string[]) => ({
    expand: "description,lead,issueTypes,url,projectKeys,permissions,insight",
    ...projectRefJson(c, p),
    ...(isCloud ? { style: p.style, isPrivate: false, properties: {} } : {}),
    ...(p.archived ? { archived: true } : {}),
    ...(expand.includes("issueTypes") ? { issueTypes: p.issueTypes.map((t) => issueTypeJson(c, p, t)) } : {}),
    ...(expand.includes("projectKeys") ? { projectKeys: p.projectKeys ?? [p.key] } : {}),
  });
  route("GET", "/rest/api/{v}/project/search", ({ c, q }) => {
    const keys = list(q, "keys").map((k) => k.toUpperCase());
    const ids = list(q, "id");
    const text = q.get("query")?.toLowerCase();
    const type = q.get("typeKey");
    const hits = site.projects.filter((p) => !p.archived && (!keys.length || keys.includes(p.key)) && (!ids.length || ids.includes(p.id))
      && (!text || p.key.toLowerCase().includes(text) || p.name.toLowerCase().includes(text)) && (!type || p.projectTypeKey === type));
    const startAt = Number(q.get("startAt") ?? 0), maxResults = Math.min(Number(q.get("maxResults") ?? 50), 100);
    const page = hits.slice(startAt, startAt + maxResults);
    return json(200, { self: `${c.base}/rest/api/${c.v}/project/search`, maxResults, startAt, total: hits.length, isLast: startAt + maxResults >= hits.length, values: page.map((p) => projectJson(c, p, list(q, "expand"))) });
  }, { cloudOnly: true });
  route("GET", "/rest/api/{v}/project", ({ c, q }) => json(200, site.projects.filter((p) => !p.archived).map((p) => projectJson(c, p, list(q, "expand")))), { dcOnly: true });
  route("GET", "/rest/api/{v}/project/:project", ({ c, q, p }) => {
    const proj = findProject(p.project!);
    return proj ? json(200, projectJson(c, proj, ["issueTypes", ...list(q, "expand")])) : errors(404, [`No project could be found with key '${p.project}'.`]);
  });
  route("GET", "/rest/api/{v}/issuetype/project", ({ c, q }) => {
    const proj = findProject(q.get("projectId") ?? "");
    if (!proj) return errors(404, ["The project is not found or the user does not have the necessary permission."]);
    const level = q.get("level");
    return json(200, proj.issueTypes.filter((t) => level === null || t.hierarchyLevel === Number(level)).map((t) => issueTypeJson(c, proj, t)));
  }, { cloudOnly: true });
  route("GET", "/rest/api/{v}/project/:project/statuses", ({ c, p }) => {
    const proj = findProject(p.project!);
    if (!proj) return errors(404, [`No project could be found with key '${p.project}'.`]);
    return json(200, proj.issueTypes.map((t) => ({
      self: `${c.base}/rest/api/${c.v}/issueType/${t.id}`, id: t.id, name: t.name, subtask: t.subtask,
      statuses: site.workflows[t.workflow]!.statuses.map((sid) => statusJson(c, statusById(sid))),
    })));
  });
  route("GET", "/rest/api/{v}/project/:project/hierarchy", ({ p }) => {
    const proj = findProject(p.project!);
    if (!proj) return errors(404, ["The project is not found or the user does not have the necessary permission."]);
    const levels = [...new Set(proj.issueTypes.map((t) => t.hierarchyLevel))].sort((a, b) => (a < 0) !== (b < 0) ? (a < 0 ? 1 : -1) : a - b);
    const names: Record<number, string> = { [-1]: "Subtask", 0: "Base", 1: "Epic" };
    return json(200, {
      projectId: Number(proj.id),
      hierarchy: levels.map((level) => ({ entityId: `fake-level-${level}`, level, name: names[level] ?? `Level ${level}`, issueTypes: proj.issueTypes.filter((t) => t.hierarchyLevel === level).map((t) => ({ id: Number(t.id), name: t.name, avatarId: 10300 })) })),
    });
  }, { cloudOnly: true });
  route("GET", "/rest/api/{v}/field", () => json(200, site.fields.map((f) => ({
    id: f.id, ...(f.key ? { key: f.key } : {}), name: f.name, custom: f.custom, orderable: true, navigable: f.id !== "comment", searchable: true, clauseNames: f.clauseNames,
    ...(f.schema ? { schema: f.schema } : {}),
    ...(f.scopeProjectId ? { scope: { type: "PROJECT", project: { id: f.scopeProjectId } } } : {}),
  }))));
  const resolutionJson = (c: RenderContext, r: Site["resolutions"][number]) => ({ self: `${c.base}/rest/api/${c.v}/resolution/${r.id}`, id: r.id, description: "", name: r.name, ...(isCloud ? { default: r.isDefault } : {}) });
  route("GET", "/rest/api/{v}/resolution/search", ({ c, q }) => {
    const startAt = Number(q.get("startAt") ?? 0), maxResults = Number(q.get("maxResults") ?? 50);
    const all = site.resolutions.filter((r) => q.get("onlyDefault") !== "true" || r.isDefault);
    return json(200, { self: `${c.base}/rest/api/${c.v}/resolution/search`, maxResults, startAt, total: all.length, isLast: startAt + maxResults >= all.length, values: all.slice(startAt, startAt + maxResults).map((r) => resolutionJson(c, r)) });
  }, { cloudOnly: true });
  route("GET", "/rest/api/{v}/resolution", ({ c }) => json(200, site.resolutions.map((r) => resolutionJson(c, r))), { dcOnly: true });
  route("GET", "/rest/api/{v}/mypermissions", ({ q }) => {
    const wanted = list(q, "permissions");
    if (isCloud && wanted.length === 0) return errors(400, ["The permissions query parameter was not provided."]);
    let projects = Object.keys(site.permissions);
    const pk = q.get("projectKey") ?? q.get("projectId");
    const ik = q.get("issueKey") ?? q.get("issueId");
    if (pk) { const proj = findProject(pk); if (!proj) return errors(404, [`No project could be found with key '${pk}'.`]); projects = [proj.key]; }
    if (ik) { const i = findIssue(ik); if (!i) return errors(404, [NO_ISSUE]); projects = [i.project]; }
    const keys = wanted.length ? wanted : Object.keys(PERMISSION_NAMES);
    return json(200, { permissions: Object.fromEntries(keys.map((k) => [k, {
      id: PERMISSION_IDS[k] ?? "0", key: k, name: PERMISSION_NAMES[k] ?? k, type: "PROJECT", description: `${PERMISSION_NAMES[k] ?? k}.`,
      havePermission: projects.some((p) => can(p, k)),
    }])) });
  });
  // Filters visible to myself (a board filter not shared with myself isn't listed). `jql` only with
  // `expand=jql`, as the spec's FilterDetails says.
  route("GET", "/rest/api/{v}/filter/search", ({ c, q }) => {
    const ids = list(q, "id");
    const name = (q.get("filterName") ?? "").toLowerCase();
    const project = q.get("projectId");
    const withJql = list(q, "expand").includes("jql");
    const all = site.boards
      .filter((b) => b.filter.shared !== false && (!ids.length || ids.includes(b.filter.id)) && (!name || `filter for ${b.name}`.toLowerCase().includes(name))
        && (!project || site.projects.find((p) => p.key === b.projectKey)?.id === project))
      .map((b) => ({ self: `${c.base}/rest/api/${c.v}/filter/${b.filter.id}`, id: b.filter.id, name: `Filter for ${b.name}`, ...(withJql ? { jql: b.filter.jql } : {}) }));
    const startAt = Number(q.get("startAt") ?? 0), maxResults = Number(q.get("maxResults") ?? 50);
    const values = all.slice(startAt, startAt + maxResults);
    return json(200, { self: `${c.base}/rest/api/${c.v}/filter/search`, maxResults, startAt, total: all.length, isLast: startAt + values.length >= all.length, values });
  });
  route("GET", "/rest/api/{v}/filter/:id", ({ c, p }) => {
    const b = site.boards.find((b) => b.filter.id === p.id);
    if (!b || b.filter.shared === false) return errors(400, [`The selected filter is not available to you, perhaps it has been deleted or had its permissions changed.`]);
    return json(200, {
      self: `${c.base}/rest/api/${c.v}/filter/${b.filter.id}`, id: b.filter.id, name: `Filter for ${b.name}`, owner: userJson(c, meRef),
      jql: b.filter.jql, viewUrl: `${c.base}/issues/?filter=${b.filter.id}`, searchUrl: `${c.base}/rest/api/${c.v}/search/jql?jql=${encodeURIComponent(b.filter.jql)}`,
      favourite: false, favouritedCount: 0, sharePermissions: [], editPermissions: [],
    });
  });
  route("GET", "/rest/api/{v}/statuses/search", ({ c, q }) => {
    if (!opts.admin) return notAdmin();
    const proj = q.get("projectId");
    const all = site.statuses.filter((s) => !proj || !s.scopeProjectId || s.scopeProjectId === proj);
    const startAt = Number(q.get("startAt") ?? 0), maxResults = Number(q.get("maxResults") ?? 200);
    return json(200, { self: `${c.base}/rest/api/${c.v}/statuses/search`, maxResults, startAt, total: all.length, isLast: startAt + maxResults >= all.length,
      values: all.slice(startAt, startAt + maxResults).map((s) => ({ id: s.id, name: s.name, description: "", statusCategory: workflowCategory(s), scope: scopeOf(s) })) });
  }, { cloudOnly: true });
  route("POST", "/rest/api/{v}/workflows", ({ body }) => {
    if (!opts.admin) return notAdmin();
    const b = (body ?? {}) as { projectAndIssueTypes?: { projectId: string; issueTypeId: string }[]; workflowNames?: string[] };
    const names = new Set(b.workflowNames ?? []);
    for (const pair of b.projectAndIssueTypes ?? []) {
      const t = site.projects.find((p) => p.id === pair.projectId)?.issueTypes.find((t) => t.id === pair.issueTypeId);
      if (t) names.add(t.workflow);
    }
    const wfs = [...names].map((n) => site.workflows[n]).filter((w): w is NonNullable<typeof w> => !!w);
    const statusIds = [...new Set(wfs.flatMap((w) => w.statuses))];
    return json(200, {
      statuses: statusIds.map((id) => { const s = statusById(id); return { id, name: s.name, description: "", statusCategory: workflowCategory(s), statusReference: id, scope: scopeOf(s) }; }),
      workflows: wfs.map((w) => ({
        id: `fake-workflow-${w.name.replace(/\W+/g, "-").toLowerCase()}`, name: w.name, description: "", isEditable: true, scope: { type: "GLOBAL" },
        version: { id: "00000000-0000-0000-0000-000000000000", versionNumber: 0 },
        statuses: w.statuses.map((id) => ({ statusReference: id, deprecated: false, properties: {}, layout: { x: 0, y: 0 } })),
        transitions: [
          { id: "1", name: "Create", description: "", type: "INITIAL", toStatusReference: w.initial, links: [], actions: [], validators: [], triggers: [], properties: {} },
          ...w.transitions.map((t) => ({
            id: t.id, name: t.name, description: "", type: t.from === "*" ? "GLOBAL" : "DIRECTED", toStatusReference: t.to,
            links: t.from === "*" ? [] : t.from.map((f) => ({ fromStatusReference: f, fromPort: 0, toPort: 1 })),
            actions: [], validators: [], triggers: [], properties: {},
            ...(t.condition ? { conditions: { operation: "ALL", conditions: [{ ruleKey: t.condition.kind === "assigneeOnly" ? "system:restrict-issue-transition" : "system:restrict-to-users", parameters: {} }], conditionGroups: [] } } : {}),
          })),
        ],
      })),
    });
  }, { cloudOnly: true, versions: [3] });

  // Search
  const searchJql = ({ c, q, body }: Ctx, post: boolean): Reply => {
    const b = (post ? body ?? {} : {}) as { jql?: string; nextPageToken?: string; maxResults?: number; fields?: string[]; expand?: string; properties?: string[]; reconcileIssues?: number[] };
    const jql = post ? b.jql ?? "" : q.get("jql") ?? "";
    const fields = post ? b.fields : q.getAll("fields");
    const expand = (post ? b.expand ?? "" : q.get("expand") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const properties = post ? b.properties ?? [] : list(q, "properties");
    const reconcile = (post ? (b.reconcileIssues ?? []).map(String) : list(q, "reconcileIssues"));
    if (properties.length > 5) return errors(400, ["A maximum of 5 issue property keys can be specified."]);
    if (reconcile.length > 50) return errors(400, ["A maximum of 50 issues can be reconciled."]);
    const parsed = parseOr400(jql);
    if (parsed instanceof Reply) return parsed;
    if (!parsed.where) return errors(400, ["Unbounded JQL queries are not allowed here. Please add a search restriction to your query."]);
    const sel = selectFields(fields, "id", site);
    const idOrKeyOnly = sel.idOnly || sel.ids.size === 0;
    const cap = idOrKeyOnly ? 5000 : 100;
    const maxResults = Math.min(Number((post ? b.maxResults : q.get("maxResults")) ?? 50), cap);
    const token = post ? b.nextPageToken : q.get("nextPageToken") ?? undefined;
    let offset = 0;
    if (token) {
      const t = decodeToken(token);
      if (!t || t.jql !== jql || typeof t.offset !== "number") return errors(400, ["The provided next page token is invalid or expired."]);
      offset = t.offset;
    }
    const { hits } = searchIssues(parsed, new Set(reconcile));
    const page = hits.slice(offset, offset + maxResults);
    const isLast = offset + maxResults >= hits.length;
    const o = renderOptions(fields, "id", expand, properties, true, c);
    return json(200, {
      issues: page.map((i) => issueJson(c, i, o)),
      ...(isLast ? {} : { nextPageToken: encodeToken({ jql, offset: offset + maxResults }) }),
      isLast,
    });
  };
  // CHANGE-2046's count for /search/jql: approximate in Jira, exact here; bounded JQL only.
  route("POST", "/rest/api/{v}/search/approximate-count", ({ body }) => {
    const parsed = parseOr400(((body ?? {}) as { jql?: string }).jql ?? "");
    if (parsed instanceof Reply) return parsed;
    if (!parsed.where) return errors(400, ["Unbounded JQL queries are not allowed here. Please add a search restriction to your query."]);
    return json(200, { count: searchIssues(parsed, new Set()).hits.length });
  }, { cloudOnly: true });
  route("GET", "/rest/api/{v}/search/jql", (x) => searchJql(x, false), { cloudOnly: true });
  route("POST", "/rest/api/{v}/search/jql", (x) => searchJql(x, true), { cloudOnly: true });
  const offsetSearch = ({ c, q, body }: Ctx, post: boolean): Reply => {
    if (isCloud) return errors(410, [OLD_SEARCH_GONE]);
    const b = (post ? body ?? {} : {}) as { jql?: string; startAt?: number; maxResults?: number; fields?: string[]; expand?: string[]; validateQuery?: boolean | string };
    const jql = post ? b.jql ?? "" : q.get("jql") ?? "";
    const startAt = Number((post ? b.startAt : q.get("startAt")) ?? 0);
    const maxResults = Math.min(Number((post ? b.maxResults : q.get("maxResults")) ?? 50), 1000);
    const fields = post ? b.fields : q.getAll("fields");
    const expand = post ? b.expand ?? [] : list(q, "expand");
    const validate = String((post ? b.validateQuery : q.get("validateQuery")) ?? "true");
    const parsed = parseOr400(jql);
    if (parsed instanceof Reply) return parsed;
    const { hits, errors: semantic } = searchIssues(parsed, new Set());
    if (semantic.length && (validate === "true" || validate === "strict")) return errors(400, semantic);
    const o = renderOptions(fields, "*navigable", expand, [], false, c);
    return json(200, {
      expand: "schema,names", startAt, maxResults, total: hits.length,
      issues: hits.slice(startAt, startAt + maxResults).map((i) => issueJson(c, i, o)),
      ...(semantic.length ? { warningMessages: semantic } : {}),
    });
  };
  route("GET", "/rest/api/{v}/search", (x) => offsetSearch(x, false));
  route("POST", "/rest/api/{v}/search", (x) => offsetSearch(x, true));
  route("POST", "/rest/api/{v}/jql/parse", ({ q, body }) => {
    const queries = ((body ?? {}) as { queries?: string[] }).queries;
    if (!Array.isArray(queries)) return errors(400, ["The queries field is required."]);
    const mode = q.get("validation") ?? "strict";
    return json(200, { queries: queries.map((query) => {
      try {
        const parsed = parseJql(query);
        const semantic = compileJql(parsed, jqlContext()).errors;
        return { query, structure: structureOf(parsed), ...(semantic.length && mode !== "none" ? (mode === "warn" ? { warnings: semantic } : { errors: semantic }) : {}) };
      } catch (e) {
        if (e instanceof JqlSyntaxError) return { query, errors: [e.message] };
        throw e;
      }
    }) });
  }, { cloudOnly: true });

  // Bulk
  route("POST", "/rest/api/{v}/issue/bulkfetch", ({ c, body }) => {
    const b = (body ?? {}) as { issueIdsOrKeys?: string[]; fields?: string[]; expand?: string[]; properties?: string[] };
    const ids = b.issueIdsOrKeys ?? [];
    if (ids.length === 0) return errors(400, ["At least one issue ID or key must be provided."]);
    if ((b.properties ?? []).length > 5) return errors(400, ["A maximum of 5 issue property keys can be specified."]);
    const fieldTokens = (b.fields ?? []).flatMap((f) => f.split(",")).map((f) => f.trim()).filter(Boolean);
    const includes = fieldTokens.filter((f) => !f.startsWith("-"));
    const multi = new Set(fieldsFor(site, undefined).filter((f) => f.multi).map((f) => f.id).concat(site.fields.filter((f) => f.schema?.type === "array").map((f) => f.id)));
    const heavyExpand = (b.expand ?? []).some((e) => ["changelog", "editmeta", "operations", "renderedFields", "transitions", "versionedRepresentations"].includes(e));
    const eligible = includes.length > 0 && includes.length <= 100 && !includes.some((f) => f.startsWith("*") || multi.has(f)) && !heavyExpand;
    const max = eligible ? 1000 : 100;
    if (ids.length > max) return errors(400, [`You can request up to ${max} issues per call with these fields and expand options.`]);
    const issueErrors: { id: string; errorMessage: string }[] = [];
    const found = new Map<string, SiteIssue>();
    for (const ref of ids) {
      const raw = lookup(ref);
      const injected = opts.issueErrors?.[ref] ?? (raw ? opts.issueErrors?.[raw.id] ?? opts.issueErrors?.[raw.key] : undefined);
      if (injected !== undefined) { issueErrors.push({ id: raw?.id ?? ref, errorMessage: injected }); continue; }
      if (raw && visible(raw)) found.set(raw.id, raw);
    }
    const o = renderOptions(b.fields, "*navigable", b.expand ?? [], b.properties ?? [], true, c);
    return json(200, { issues: [...found.values()].sort((a, z) => Number(a.id) - Number(z.id)).map((i) => issueJson(c, i, o)), issueErrors });
  }, { cloudOnly: true });
  route("POST", "/rest/api/{v}/jql/match", ({ body }) => {
    const b = (body ?? {}) as { jqls?: string[]; issueIds?: number[] };
    const jqls = b.jqls ?? [], ids = b.issueIds ?? [];
    if (jqls.length > 10 || ids.length > 50) return errors(400, ["jqls can contain at most 10 queries and issueIds at most 50 issue IDs."]);
    const pool = ids.map((id) => site.issues.find((i) => i.id === String(id))).filter((i): i is SiteIssue => !!i && visible(i));
    return json(200, { matches: jqls.map((jql) => {
      try {
        const compiled = compileJql(parseJql(jql), jqlContext());
        return { matchedIssues: pool.filter((i) => compiled.matches(i)).map((i) => Number(i.id)), errors: [] };
      } catch (e) {
        if (e instanceof JqlSyntaxError) return { matchedIssues: [], errors: [e.message] };
        throw e;
      }
    }) });
  }, { cloudOnly: true });
  route("POST", "/rest/api/{v}/changelog/bulkfetch", ({ c, body }) => {
    const b = (body ?? {}) as { issueIdsOrKeys?: string[]; fieldIds?: string[]; maxResults?: number; nextPageToken?: string };
    const ids = b.issueIdsOrKeys ?? [];
    if (ids.length === 0 || ids.length > 1000) return errors(400, ["issueIdsOrKeys must contain between 1 and 1000 issue IDs or keys."]);
    if ((b.fieldIds ?? []).length > 10) return errors(400, ["fieldIds can contain at most 10 field IDs."]);
    const maxResults = Math.min(Math.max(b.maxResults ?? 1000, 1), 10000);
    const fieldIds = b.fieldIds?.length ? new Set(b.fieldIds) : undefined;
    const seen = new Set<string>();
    const rows: { issue: SiteIssue; h: SiteIssue["changelog"][number] }[] = [];
    for (const ref of ids) {
      const i = findIssue(ref);
      if (!i || seen.has(i.id)) continue;
      seen.add(i.id);
      for (const h of i.changelog) {
        const items = fieldIds ? h.items.filter((it) => it.fieldId && fieldIds.has(it.fieldId)) : h.items;
        if (items.length) rows.push({ issue: i, h: { ...h, items } });
      }
    }
    const request = JSON.stringify([ids, b.fieldIds ?? []]);
    let offset = 0;
    if (b.nextPageToken) {
      const t = decodeToken(b.nextPageToken);
      if (!t || t.request !== request || typeof t.offset !== "number") return errors(400, ["The provided next page token is invalid or expired."]);
      offset = t.offset;
    }
    const page = rows.slice(offset, offset + maxResults);
    const grouped = new Map<string, Json[]>();
    for (const r of page) grouped.set(r.issue.id, [...(grouped.get(r.issue.id) ?? []), historyJson(c, r.h)]);
    return json(200, {
      issueChangeLogs: [...grouped].map(([issueId, changeHistories]) => ({ issueId, changeHistories })),
      ...(offset + maxResults < rows.length ? { nextPageToken: encodeToken({ request, offset: offset + maxResults }) } : {}),
    });
  }, { cloudOnly: true });

  // Issues
  route("GET", "/rest/api/{v}/issue/:key", withIssue(({ c, q }, i) => json(200, issueJson(c, i, renderOptions(q.getAll("fields"), "*all", list(q, "expand"), list(q, "properties"), false, c)))));
  route("GET", "/rest/api/{v}/issue/:key/comment", withIssue(({ c, q }, i) => {
    const orderBy = q.get("orderBy");
    if (orderBy && !["created", "+created", "-created"].includes(orderBy)) return errors(400, [`The orderBy parameter only supports 'created'.`]);
    const startAt = Number(q.get("startAt") ?? 0), maxResults = Number(q.get("maxResults") ?? 100);
    const all = orderBy === "-created" ? [...i.comments].reverse() : i.comments;
    return json(200, { startAt, maxResults, total: all.length, comments: all.slice(startAt, startAt + maxResults).map((cm) => commentJson(c, i, cm)) });
  }));
  route("GET", "/rest/api/{v}/issue/:key/changelog", withIssue(({ c, q }, i) => {
    const startAt = Number(q.get("startAt") ?? 0), maxResults = Math.min(Number(q.get("maxResults") ?? 100), 100);
    const isLast = startAt + maxResults >= i.changelog.length;
    return json(200, {
      self: `${c.base}/rest/api/${c.v}/issue/${i.key}/changelog?startAt=${startAt}&maxResults=${maxResults}`,
      ...(isLast ? {} : { nextPage: `${c.base}/rest/api/${c.v}/issue/${i.key}/changelog?startAt=${startAt + maxResults}&maxResults=${maxResults}` }),
      maxResults, startAt, total: i.changelog.length, isLast, values: i.changelog.slice(startAt, startAt + maxResults).map((h) => historyJson(c, h)),
    });
  }), { cloudOnly: true });

  // Writes
  route("GET", "/rest/api/{v}/issue/:key/transitions", withIssue(({ c, q }, i) => json(200, { expand: "transitions", transitions: listTransitions(c, i, q) })));
  route("POST", "/rest/api/{v}/issue/:key/transitions", withIssue(({ c, body }, i) => {
    const limited = writeGate(i);
    if (limited) return limited;
    const b = (body ?? {}) as { transition?: { id?: string }; fields?: Json; update?: Record<string, { add?: { body?: unknown }; set?: unknown }[]>; properties?: { key: string; value: unknown }[] };
    const id = b.transition?.id;
    if (!id) return errors(400, ["Missing 'transition' identifier"]);
    if (!can(i.project, "TRANSITION_ISSUES")) return errors(400, ["You do not have permission to transition this issue."]);
    const t = transitionCandidates(i).find((t) => t.id === String(id));
    if (!t) return errors(400, [`Transition id '${id}' is not valid for this issue.`]);
    if (!conditionMet(t, i)) return errors(400, [`It seems that you have tried to perform a workflow operation (${t.name}) that is not valid for the current state of this issue (${i.key}). The likely cause is that somebody has changed the issue recently, please look at the issue history for details.`]);
    const fields = b.fields ?? {}, update = b.update ?? {};
    const errs: Record<string, string> = {};
    for (const k of Object.keys(fields)) if (k in update) errs[k] = `Field '${k}' cannot be set in both 'fields' and 'update'.`;
    for (const k of [...Object.keys(fields), ...Object.keys(update)]) if (!(k in t.fields)) errs[k] = `Field '${k}' cannot be set. It is not on the appropriate screen, or unknown.`;
    for (const [k, meta] of Object.entries(t.fields)) if (meta.required && !meta.hasDefaultValue && !(k in fields) && !(k in update)) errs[k] = `${meta.name} is required.`;
    let resolution: string | undefined;
    if ("resolution" in fields && !errs.resolution) {
      const want = fields.resolution as { id?: string; name?: string } | null;
      const allowed = t.fields.resolution?.allowedValues ?? [];
      const hit = allowed.find((a) => (want?.id && a.id === want.id) || (want?.name && a.name === want.name));
      if (!hit) errs.resolution = "Could not find valid 'id' or 'name' in resolution object.";
      else resolution = hit.name;
    }
    for (const [k, msg] of Object.entries(t.hiddenRequired ?? {})) if (!errs[k]) errs[k] = msg;
    if (Object.keys(errs).length) return errors(400, [], errs);

    remember(i);
    const from = statusById(i.status), to = statusById(t.to);
    const items: SiteIssue["changelog"][number]["items"] = [{ field: "status", fieldId: "status", from: from.id, fromString: from.name, to: to.id, toString: to.name }];
    const oldResolution = i.resolution;
    i.status = t.to;
    i.resolution = to.statusCategory.key === "done" ? resolution ?? oldResolution ?? site.resolutions.find((r) => r.isDefault)?.name ?? null : null;
    if (i.resolution !== oldResolution) {
      const rid = (n: string | null) => site.resolutions.find((r) => r.name === n)?.id ?? null;
      items.push({ field: "resolution", fieldId: "resolution", from: rid(oldResolution), fromString: oldResolution, to: rid(i.resolution), toString: i.resolution });
    }
    for (const op of update.comment ?? []) if (op.add?.body !== undefined) i.comments.push(newComment(c, op.add.body));
    for (const p of b.properties ?? []) i.properties[p.key] = p.value;
    history(i, items);
    touch(i);
    return empty(204);
  }));
  const newComment = (c: RenderContext, body: unknown, visibility?: { type: "role" | "group"; value: string }): SiteIssue["comments"][number] => {
    const t = formatJiraTime(now());
    const rich = isCloud ? { adf: c.v === 3 ? body : textToAdf(String(body)) } : { wiki: String(body) };
    return { id: newId(), author: meRef, body: rich, created: t, updated: t, ...(visibility ? { visibility } : {}) };
  };
  route("PUT", "/rest/api/{v}/issue/:key/assignee", withIssue(({ body }, i) => {
    const limited = writeGate(i);
    if (limited) return limited;
    if (!can(i.project, "ASSIGN_ISSUES")) return errors(403, ["You do not have permission to assign issues."]);
    const b = (body ?? {}) as { accountId?: string | null; name?: string | null; key?: string | null };
    const field = isCloud ? "accountId" : "name" in b ? "name" : "key";
    if (!(field in b)) return errors(400, [], { assignee: `The ${isCloud ? "accountId" : "name"} is required.` });
    return assign(i, b[field as "accountId"] ?? null) ?? empty(204);
  }));
  /** Sets the assignee (null or "-1" = unassigned); a 400 Reply when the user can't be assigned. */
  const assign = (i: SiteIssue, ref: string | null): Reply | undefined => {
    let next: string | null = null;
    if (ref !== null && ref !== "-1") {
      const u = findUser(site, ref);
      if (!u) return errors(400, [], { assignee: `User '${ref}' does not exist.` });
      const assignable = u.active && (userRef(site, u) !== meRef || can(i.project, "ASSIGNABLE_USER"));
      if (!assignable) return errors(400, [], { assignee: `User '${u.displayName}' cannot be assigned issues.` });
      next = userRef(site, u);
    }
    if (next === i.assignee) return undefined;
    remember(i);
    const name = (r: string | null) => findUser(site, r)?.displayName ?? null;
    history(i, [{ field: "assignee", fieldId: "assignee", from: i.assignee, fromString: name(i.assignee), to: next, toString: name(next) }]);
    i.assignee = next;
    touch(i);
    return undefined;
  };
  // Edit: summary, description, labels and assignee, the fields the sync's push owns (design §8.1).
  route("PUT", "/rest/api/{v}/issue/:key", withIssue(({ c, body }, i) => {
    const limited = writeGate(i);
    if (limited) return limited;
    if (!can(i.project, "EDIT_ISSUES")) return errors(403, ["You do not have permission to edit this issue."]);
    const fields = ((body ?? {}) as { fields?: Json }).fields ?? {};
    const errs: Record<string, string> = {};
    for (const k of Object.keys(fields)) if (!["summary", "description", "labels", "assignee"].includes(k)) errs[k] = `Field '${k}' cannot be set. It is not on the appropriate screen, or unknown.`;
    if ("summary" in fields && (typeof fields.summary !== "string" || fields.summary.trim() === "")) errs.summary = "You must specify a summary of the issue.";
    if ("labels" in fields && (!Array.isArray(fields.labels) || fields.labels.some((l) => typeof l !== "string" || /\s/.test(l)))) errs.labels = "Labels must be strings without spaces.";
    const d = fields.description as { type?: string } | string | null | undefined;
    if ("description" in fields && d !== null && (c.v === 3 ? typeof d !== "object" || d?.type !== "doc" : typeof d !== "string")) errs.description = c.v === 3 ? "Operation value must be an Atlassian Document (see the Atlassian Document Format)" : "Operation value must be a string";
    if (Object.keys(errs).length) return errors(400, [], errs);
    if ("assignee" in fields) {
      const a = fields.assignee as { accountId?: string | null; name?: string | null } | null;
      const refused = assign(i, a === null ? null : (a.accountId ?? a.name ?? null));
      if (refused) return refused;
    }
    const items: SiteIssue["changelog"][number]["items"] = [];
    if ("summary" in fields && fields.summary !== i.summary) {
      items.push({ field: "summary", fieldId: "summary", from: null, fromString: i.summary, to: null, toString: fields.summary as string });
      i.summary = fields.summary as string;
    }
    if ("labels" in fields) {
      const next = [...new Set(fields.labels as string[])];
      if (next.join(" ") !== i.labels.join(" ")) items.push({ field: "labels", fieldId: "labels", from: null, fromString: i.labels.join(" "), to: null, toString: next.join(" ") });
      i.labels = next;
    }
    if ("description" in fields) {
      items.push({ field: "description", fieldId: "description", from: null, fromString: null, to: null, toString: null });
      i.description = d === null ? null : isCloud ? { adf: c.v === 3 ? d : textToAdf(String(d)) } : { wiki: String(d) };
    }
    if (items.length) { remember(i); history(i, items); touch(i); }
    return empty(204);
  }));
  route("POST", "/rest/api/{v}/issue/:key/comment", withIssue(({ c, body }, i) => {
    const limited = writeGate(i);
    if (limited) return limited;
    if (!can(i.project, "ADD_COMMENTS")) return errors(400, ["You do not have the permission to comment on this issue."]);
    const b = (body ?? {}) as { body?: unknown; visibility?: { type: "role" | "group"; value: string } };
    if (c.v === 3) {
      const doc = b.body as { type?: string } | undefined;
      if (!doc || typeof doc !== "object" || doc.type !== "doc") return errors(400, [], { comment: "Operation value must be an Atlassian Document (see the Atlassian Document Format)" });
    } else if (typeof b.body !== "string" || b.body.trim() === "") return errors(400, [], { comment: "Comment body can not be empty!" });
    if (i.comments.length >= limits.comments) return errors(413, [`The comment limit of ${limits.comments} per issue has been reached.`]);
    remember(i);
    const cm = newComment(c, b.body, b.visibility);
    i.comments.push(cm);
    touch(i);
    return json(201, commentJson(c, i, cm));
  }));
  route("PUT", "/rest/api/{v}/issue/:key/comment/:id", withIssue(({ c, body, p }, i) => {
    const limited = writeGate(i);
    if (limited) return limited;
    const cm = i.comments.find((x) => x.id === p.id);
    if (!cm) return errors(404, ["Can not find a comment for the id: " + p.id + "."]);
    if (cm.author !== meRef) return errors(403, ["You do not have the permission to edit this comment."]);
    const b = (body ?? {}) as { body?: unknown };
    if (c.v === 3 && (b.body as { type?: string } | undefined)?.type !== "doc") return errors(400, [], { comment: "Operation value must be an Atlassian Document (see the Atlassian Document Format)" });
    if (c.v === 2 && (typeof b.body !== "string" || b.body.trim() === "")) return errors(400, [], { comment: "Comment body can not be empty!" });
    remember(i);
    cm.body = isCloud ? { adf: c.v === 3 ? b.body : textToAdf(String(b.body)) } : { wiki: String(b.body) };
    cm.updated = formatJiraTime(now());
    touch(i);
    return json(200, commentJson(c, i, cm));
  }));
  const linkJson = (c: RenderContext, i: SiteIssue, l: SiteIssue["remoteLinks"][number]) => dropNulls({
    id: l.id, self: `${c.base}/rest/api/${c.v}/issue/${i.key}/remotelink/${l.id}`, globalId: l.globalId,
    application: (l as Json).application, relationship: (l as Json).relationship, object: dropNulls(l.object),
  });
  route("GET", "/rest/api/{v}/issue/:key/remotelink", withIssue(({ c, q }, i) => {
    const g = q.get("globalId");
    if (g !== null) { const l = i.remoteLinks.find((l) => l.globalId === g); return l ? json(200, linkJson(c, i, l)) : errors(404, ["No remote link with that globalId."]); }
    return json(200, i.remoteLinks.map((l) => linkJson(c, i, l)));
  }));
  route("GET", "/rest/api/{v}/issue/:key/remotelink/:linkId", withIssue(({ c, p }, i) => {
    const l = i.remoteLinks.find((l) => String(l.id) === p.linkId);
    return l ? json(200, linkJson(c, i, l)) : errors(404, ["No remote link with that id."]);
  }));
  route("POST", "/rest/api/{v}/issue/:key/remotelink", withIssue(({ c, body }, i) => {
    const limited = writeGate(i);
    if (limited) return limited;
    if (!can(i.project, "LINK_ISSUES")) return errors(403, ["You do not have permission to link issues."]);
    const b = (body ?? {}) as { globalId?: string; application?: unknown; relationship?: string; object?: { url?: string; title?: string } };
    const errs: Record<string, string> = {};
    if (!b.object?.url) errs.url = "'url' is required.";
    if (!b.object?.title) errs.title = "'title' is required.";
    if (b.globalId && b.globalId.length > 255) errs.globalId = "The globalId must not be longer than 255 characters.";
    if (Object.keys(errs).length) return errors(400, [], errs);
    const existing = b.globalId ? i.remoteLinks.find((l) => l.globalId === b.globalId) : undefined;
    if (!existing && i.remoteLinks.length >= limits.remoteLinks) return errors(413, [`The remote link limit of ${limits.remoteLinks} per issue has been reached.`]);
    remember(i);
    // An update replaces the whole link: every field the request leaves out becomes null (design §8.1).
    const link = { id: existing?.id ?? Number(newId()), globalId: b.globalId, application: b.application ?? null, relationship: b.relationship ?? null, object: b.object as { url: string; title: string } };
    if (existing) i.remoteLinks[i.remoteLinks.indexOf(existing)] = link; else i.remoteLinks.push(link);
    touch(i);
    return json(existing ? 200 : 201, { id: link.id, self: `${c.base}/rest/api/${c.v}/issue/${i.key}/remotelink/${link.id}` });
  }));
  const deleteLink = (i: SiteIssue, pick: (l: SiteIssue["remoteLinks"][number]) => boolean): Reply => {
    const limited = writeGate(i);
    if (limited) return limited;
    if (!can(i.project, "LINK_ISSUES")) return errors(403, ["You do not have permission to link issues."]);
    const n = i.remoteLinks.findIndex(pick);
    if (n < 0) return errors(404, ["No remote link matches."]);
    remember(i);
    i.remoteLinks.splice(n, 1);
    touch(i);
    return empty(204);
  };
  route("DELETE", "/rest/api/{v}/issue/:key/remotelink", withIssue(({ q }, i) => {
    const g = q.get("globalId");
    return g === null ? errors(400, ["A globalId is required."]) : deleteLink(i, (l) => l.globalId === g);
  }));
  route("DELETE", "/rest/api/{v}/issue/:key/remotelink/:linkId", withIssue(({ p }, i) => deleteLink(i, (l) => String(l.id) === p.linkId)));
  route("GET", "/rest/api/{v}/issue/:key/properties", withIssue(({ c }, i) => json(200, { keys: Object.keys(i.properties).map((key) => ({ self: `${c.base}/rest/api/${c.v}/issue/${i.id}/properties/${key}`, key })) })));
  route("GET", "/rest/api/{v}/issue/:key/properties/:prop", withIssue(({ p }, i) =>
    p.prop! in i.properties ? json(200, { key: p.prop, value: i.properties[p.prop!] }) : errors(404, [`The property with key '${p.prop}' does not exist.`])));
  route("PUT", "/rest/api/{v}/issue/:key/properties/:prop", withIssue(({ p, body, raw }, i) => {
    const limited = writeGate(i);
    if (limited) return limited;
    if (!can(i.project, "EDIT_ISSUES")) return errors(403, ["You do not have permission to edit this issue."]);
    if (p.prop!.length > 255) return errors(400, ["The property key can't be longer than 255 characters."]);
    if (raw.length > 32768) return errors(400, ["The property value can't be longer than 32768 characters."]);
    if (raw.trim() === "") return errors(400, ["The property value must be valid JSON."]);
    const created = !(p.prop! in i.properties);
    remember(i);
    i.properties[p.prop!] = body;
    if (opts.propertyBumpsUpdated) touch(i);
    return empty(created ? 201 : 200);
  }));
  route("DELETE", "/rest/api/{v}/issue/:key/properties/:prop", withIssue(({ p }, i) => {
    if (!can(i.project, "EDIT_ISSUES")) return errors(403, ["You do not have permission to edit this issue."]);
    if (!(p.prop! in i.properties)) return errors(404, [`The property with key '${p.prop}' does not exist.`]);
    delete i.properties[p.prop!];
    if (opts.propertyBumpsUpdated) touch(i);
    return empty(204);
  }));

  // Agile
  const boardJson = (c: RenderContext, b: Site["boards"][number]) => {
    const proj = site.projects.find((p) => p.key === b.projectKey)!;
    return {
      id: b.id, self: `${c.base}/rest/agile/1.0/board/${b.id}`, name: b.name, type: b.type, isPrivate: false,
      location: { projectId: Number(proj.id), displayName: `${proj.name} (${proj.key})`, projectName: proj.name, projectKey: proj.key, projectTypeKey: proj.projectTypeKey, avatarURI: `${c.base}/secure/projectavatar?size=small&pid=${proj.id}`, name: `${proj.name} (${proj.key})` },
    };
  };
  const findBoard = (id: string) => site.boards.find((b) => String(b.id) === id);
  const withBoard = (h: (x: Ctx, b: Site["boards"][number]) => Reply): Handler => (x) => {
    const b = findBoard(x.p.board!);
    return b ? h(x, b) : errors(404, [`Board with id ${x.p.board} does not exist or you do not have permission to see it.`]);
  };
  route("GET", "/rest/agile/1.0/board", ({ c, q }) => {
    const proj = q.get("projectKeyOrId");
    const type = list(q, "type");
    const name = q.get("name")?.toLowerCase();
    const p = proj ? findProject(proj) : undefined;
    if (proj && !p) return errors(400, [`No project could be found with key or id '${proj}'.`]);
    const hits = site.boards.filter((b) => (!p || b.projectKey === p.key) && (!type.length || type.includes(b.type)) && (!name || b.name.toLowerCase().includes(name)));
    const startAt = Number(q.get("startAt") ?? 0), maxResults = Math.min(Number(q.get("maxResults") ?? 50), 50);
    return json(200, { maxResults, startAt, total: hits.length, isLast: startAt + maxResults >= hits.length, values: hits.slice(startAt, startAt + maxResults).map((b) => boardJson(c, b)) });
  });
  route("GET", "/rest/agile/1.0/board/:board", withBoard(({ c }, b) => json(200, boardJson(c, b))));
  route("GET", "/rest/agile/1.0/board/:board/configuration", withBoard(({ c }, b) => {
    const proj = site.projects.find((p) => p.key === b.projectKey)!;
    // A Kanban board's configuration always starts with a "Backlog" column; it is empty when the
    // backlog is off (community-sourced, design §6.2).
    const columns = b.type === "kanban" && b.columns[0]?.name !== "Backlog" ? [{ name: "Backlog", statuses: [] as string[] }, ...b.columns] : b.columns;
    const estimationField = b.estimationFieldId ? site.fields.find((f) => f.id === b.estimationFieldId) : undefined;
    return json(200, {
      id: b.id, name: b.name, type: b.type, self: `${c.base}/rest/agile/1.0/board/${b.id}/configuration`,
      location: { type: "project", projectKeyOrId: proj.id },
      filter: { id: b.filter.id, self: `${c.base}/rest/api/2/filter/${b.filter.id}` },
      ...(b.type === "kanban" && b.subQuery ? { subQuery: { query: b.subQuery } } : {}),
      columnConfig: {
        columns: columns.map((col) => ({ name: col.name, statuses: col.statuses.map((id) => ({ id, self: `${c.base}/rest/api/2/status/${id}` })), ...("min" in col && col.min !== undefined ? { min: col.min } : {}), ...("max" in col && col.max !== undefined ? { max: col.max } : {}) })),
        constraintType: columns.some((col) => "max" in col || "min" in col) ? "issueCount" : "none",
      },
      // `estimation` is Scrum only (Software OpenAPI); a Kanban estimate field comes from field discovery.
      ...(b.type === "scrum" && b.estimationFieldId ? { estimation: { type: "field", field: { fieldId: b.estimationFieldId, displayName: estimationField?.name ?? b.estimationFieldId } } } : {}),
      ...(b.rankFieldId !== undefined ? { ranking: { rankCustomFieldId: b.rankFieldId } } : {}),
    });
  }));
  route("GET", "/rest/agile/1.0/board/:board/features", withBoard((_x, b) => json(200, {
    features: Object.entries(b.features).map(([boardFeature, state]) => ({
      boardFeature, boardId: b.id, state, featureId: `jsw.agility.${boardFeature.toLowerCase()}`, featureType: boardFeature === "ESTIMATION" ? "ESTIMATION" : "BASIC",
      localisedName: boardFeature[0] + boardFeature.slice(1).toLowerCase(), localisedDescription: "", toggleLocked: false,
    })),
  })));
  const sprintJson = (c: RenderContext, s: Site["sprints"][number]) => ({
    id: s.id, self: `${c.base}/rest/agile/1.0/sprint/${s.id}`, state: s.state, name: s.name,
    ...(s.startDate ? { startDate: s.startDate } : {}), ...(s.endDate ? { endDate: s.endDate } : {}),
    ...(s.state === "closed" && s.endDate ? { completeDate: s.endDate } : {}),
    originBoardId: s.boardId, ...(s.goal ? { goal: s.goal } : {}),
  });
  route("GET", "/rest/agile/1.0/board/:board/sprint", withBoard(({ c, q }, b) => {
    if (b.type !== "scrum") return errors(400, ["The board does not support sprints"]);
    const states = list(q, "state");
    const hits = site.sprints.filter((s) => s.boardId === b.id && (!states.length || states.includes(s.state)));
    const startAt = Number(q.get("startAt") ?? 0), maxResults = Math.min(Number(q.get("maxResults") ?? 50), 50);
    return json(200, { maxResults, startAt, total: hits.length, isLast: startAt + maxResults >= hits.length, values: hits.slice(startAt, startAt + maxResults).map((s) => sprintJson(c, s)) });
  }));
  route("GET", "/rest/agile/1.0/sprint/:sprint", ({ c, p }) => {
    const s = site.sprints.find((s) => String(s.id) === p.sprint);
    return s ? json(200, sprintJson(c, s)) : errors(404, [`Sprint with id ${p.sprint} does not exist or you do not have permission to see it.`]);
  });
  /** The board's issues (its filter, AND-ed with `jql`), or only its backlog. */
  const boardIssues = (b: Site["boards"][number], extraJql: string | null, backlogOnly: boolean): SiteIssue[] | Reply => {
    const filter = parseOr400(b.filter.jql);
    if (filter instanceof Reply) return filter;
    const extra = extraJql ? parseOr400(extraJql) : { orderBy: [] } as JqlQuery;
    if (extra instanceof Reply) return extra;
    const where: JqlNode | undefined = filter.where && extra.where ? { kind: "and", a: filter.where, b: extra.where } : filter.where ?? extra.where;
    let hits = searchIssues({ where, orderBy: extra.orderBy.length ? extra.orderBy : filter.orderBy }, new Set()).hits;
    if (!backlogOnly) return hits;
    if (b.type === "scrum") {
      const open = new Set(site.sprints.filter((s) => s.state !== "closed").map((s) => s.id));
      const done = new Set(b.columns.filter((col) => col.statuses.length).at(-1)?.statuses ?? []);
      hits = hits.filter((i) => !i.sprints.some((s) => open.has(s)) && !done.has(i.status));
    } else {
      if (!b.kanbanBacklog) return errors(400, ["The board does not have a backlog."]);
      const backlog = new Set(b.columns[0]?.statuses ?? []);
      hits = hits.filter((i) => backlog.has(i.status));
    }
    return hits;
  };
  route("GET", "/rest/software/1.0/board/:board/backlog", withBoard(({ c, q }, b) => {
    const hits = boardIssues(b, q.get("jql"), true);
    if (hits instanceof Reply) return hits;
    const maxResults = Math.min(Number(q.get("maxResults") ?? 50), 5000);
    const token = q.get("nextPageToken");
    const offset = token ? Number(decodeToken(token)?.offset ?? Number.NaN) : 0;
    if (!Number.isFinite(offset)) return errors(400, ["The provided next page token is invalid or expired."]);
    const isLast = offset + maxResults >= hits.length;
    const o = renderOptions(q.getAll("fields"), "*navigable", list(q, "expand"), [], true, c);
    return json(200, { expand: "schema,names", issues: hits.slice(offset, offset + maxResults).map((i) => issueJson(c, i, o)), isLast, ...(isLast ? {} : { nextPageToken: encodeToken({ offset: offset + maxResults }) }) });
  }), { cloudOnly: true });
  const agileListing = (backlogOnly: boolean): Handler => withBoard(({ c, q }, b) => {
    if (isCloud && now() >= AGILE_LISTINGS_REMOVED) return errors(404, ["This API has been removed. Use /rest/software/1.0 (CHANGE-3193)."]);
    const hits = boardIssues(b, q.get("jql"), backlogOnly);
    if (hits instanceof Reply) return hits;
    const startAt = Number(q.get("startAt") ?? 0), maxResults = Math.min(Number(q.get("maxResults") ?? 50), 1000);
    const o = renderOptions(q.getAll("fields"), "*navigable", list(q, "expand"), [], false, c);
    return json(200, { expand: "schema,names", startAt, maxResults, total: hits.length, issues: hits.slice(startAt, startAt + maxResults).map((i) => issueJson(c, i, o)) });
  });
  route("GET", "/rest/agile/1.0/board/:board/backlog", agileListing(true));
  route("GET", "/rest/agile/1.0/board/:board/issue", agileListing(false));

  // ── Dispatch ─────────────────────────────────────────────────────────────────────────────

  const notAdmin = () => errors(401, ["You are not authorized to perform this action. Administrator privileges are required."]);

  const authenticate = (req: IncomingMessage, via: "site" | "gateway", path: string): Reply | undefined => {
    const h = req.headers.authorization ?? "";
    const unauthorized = via === "gateway"
      ? json(401, { code: 401, message: "Unauthorized" })
      : new Reply(401, "Client must be authenticated to access this resource.", { "WWW-Authenticate": 'Basic realm="protected-area"' }, true);
    if (!isCloud) return h === `Bearer ${creds.pat}` ? undefined : unauthorized;
    const basic = (token: string) => h === `Basic ${Buffer.from(`${creds.email}:${token}`).toString("base64")}`;
    if (via === "site") return basic(creds.classicToken) ? undefined : unauthorized;
    if (!basic(creds.scopedToken)) return unauthorized;
    const need = creds.scopes ? agileScopes(path) : undefined;
    // Jira's 401 doesn't say which scope is missing; a client names them from the endpoint.
    if (need && !need.every((s) => creds.scopes!.includes(s))) return json(401, { code: 401, message: "Unauthorized; scope does not match" });
    return undefined;
  };

  const faultFor = (method: string, path: string): Fault | undefined => {
    let fired: Fault | undefined;
    for (const f of site.faults) {
      if (f.match.method.toUpperCase() !== method || !globMatch(f.match.path, path)) continue;
      const n = (faultHits.get(f) ?? 0) + 1;
      faultHits.set(f, n);
      if (!fired && n >= f.match.nth && n < f.match.nth + f.match.times) fired = f;
    }
    return fired;
  };

  const dispatch = (method: string, path: string, x: Omit<Ctx, "p" | "c">, base: string): Reply => {
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(path);
      if (!m) continue;
      const v = (m.groups?.v ? Number(m.groups.v) : 3) as 2 | 3;
      if (!r.versions.includes(v) || (r.cloudOnly && !isCloud) || (r.dcOnly && isCloud) || (!isCloud && path.startsWith("/rest/api/3/"))) break;
      const p = Object.fromEntries(r.keys.map((k) => [k, decodeURIComponent(m.groups![k]!)]));
      return r.h({ ...x, p, c: { site, base, v: isCloud ? v : 2 } });
    }
    return errors(404, ["null for uri: " + path]);
  };

  /** A scripted fault for this call, or the route's answer (with the fault's headers when it is a 2xx one). */
  const answer = (method: string, path: string, x: Omit<Ctx, "p" | "c">, base: string): Reply => {
    const fault = faultFor(method, path);
    if (fault && (fault.status < 200 || fault.status > 299)) {
      return new Reply(fault.status, fault.body ?? { errorMessages: [fault.status === 429 ? "Rate limit exceeded." : fault.name], errors: {} }, fault.headers);
    }
    const r = dispatch(method, path, x, base);
    return fault ? r.with(fault.headers) : r;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://fake");
    let path = url.pathname;
    let via: "site" | "gateway" = "site";
    const origin = `http://${req.headers.host}`;
    let base = origin;
    const raw = await readBody(req);
    const method = (req.method ?? "GET").toUpperCase();
    let parsedBody: unknown;
    const send = (r: Reply) => {
      requests.push({ method, path, query: url.searchParams, body: parsedBody, via, status: r.status });
      write(res, r);
    };

    if (path === "/_edge/tenant_info") return send(isCloud ? json(200, { cloudId: site.cloudId }) : errors(404, []));
    const gw = /^\/ex\/jira\/([^/]+)(\/.*)$/.exec(path);
    if (gw) {
      via = "gateway";
      path = gw[2]!;
      if (!isCloud || gw[1] !== site.cloudId) return send(json(404, { code: 404, message: "Not Found" }));
      base = `${origin}/ex/jira/${site.cloudId}`;
    }
    const denied = authenticate(req, via, path);
    if (denied) return send(denied);
    if (raw) {
      try { parsedBody = JSON.parse(raw); } catch { return send(errors(400, ["Unexpected character in the request body: it must be JSON."])); }
    }
    send(answer(method, path, { q: url.searchParams, body: parsedBody, raw }, base));
  };

  const server = createServer((req, res) => { handle(req, res).catch((e: unknown) => { write(res, errors(500, [String(e instanceof Error ? e.stack : e)])); }); });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    gatewayUrl: isCloud ? `${url}/ex/jira/${site.cloudId}` : undefined,
    site,
    requests,
    credentials: creds,
    authorization(kind = isCloud ? "classic" : "pat") {
      if (kind === "pat") return `Bearer ${creds.pat}`;
      return `Basic ${Buffer.from(`${creds.email}:${kind === "scoped" ? creds.scopedToken : creds.classicToken}`).toString("base64")}`;
    },
    invoke(method, pathAndQuery, body) {
      const u = new URL(pathAndQuery, "http://fake");
      const r = answer(method.toUpperCase(), u.pathname, { q: u.searchParams, body, raw: body === undefined ? "" : JSON.stringify(body) }, isCloud ? `${url}/ex/jira/${site.cloudId}` : url);
      return { status: r.status, body: r.body, headers: r.headers };
    },
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

function write(res: ServerResponse, r: Reply) {
  const headers: Record<string, string> = { ...r.headers };
  if (r.body === undefined) { res.writeHead(r.status, headers); res.end(); return; }
  const text = r.text ? String(r.body) : JSON.stringify(r.body);
  headers["Content-Type"] = r.text ? "text/plain;charset=UTF-8" : "application/json;charset=UTF-8";
  res.writeHead(r.status, headers);
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * The granular scopes an Agile call needs (P-R, from the Software spec's `x-atlassian-oauth2-scopes`):
 * a scoped token with classic scopes alone gets none of them. Undefined for a platform call.
 */
export function agileScopes(path: string): string[] | undefined {
  if (path.startsWith("/rest/software/")) return ["read:board-scope:jira-software", "read:issue-details:jira", "read:jql:jira"];
  if (!path.startsWith("/rest/agile/")) return undefined;
  if (/^\/rest\/agile\/1\.0\/board\/[^/]+\/(configuration|features)$/.test(path)) return ["read:board-scope.admin:jira-software", "read:project:jira"];
  if (/^\/rest\/agile\/1\.0\/(board\/[^/]+\/sprint|sprint\/[^/]+)$/.test(path)) return ["read:sprint:jira-software"];
  if (/^\/rest\/agile\/1\.0\/board(\/[^/]+)?$/.test(path)) return ["read:board-scope:jira-software", "read:project:jira"];
  return ["read:board-scope:jira-software", "read:issue-details:jira", "read:jql:jira"];
}

/** A fault path matches exactly, or with `*` standing for one path segment. */
function globMatch(pattern: string, path: string): boolean {
  if (!pattern.includes("*")) return pattern === path;
  return new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]+")}$`).test(path);
}

function dropNulls<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as T;
}

/** `statuses/search` and `/workflows` speak TODO / IN_PROGRESS / DONE; "No Category" has no value there. */
function workflowCategory(s: Site["statuses"][number]): string {
  return { new: "TODO", indeterminate: "IN_PROGRESS", done: "DONE", undefined: "TODO" }[s.statusCategory.key];
}
function scopeOf(s: Site["statuses"][number]) {
  return s.scopeProjectId ? { type: "PROJECT", project: { id: s.scopeProjectId } } : { type: "GLOBAL" };
}

/** A small stand-in for `jql/parse`'s `structure`: the clauses and the order. */
function structureOf(q: JqlQuery): Json {
  const node = (n: JqlNode): Json =>
    n.kind === "clause" ? { field: { name: n.field }, operator: n.op, operand: { values: n.values.map((v) => (v.kind === "str" ? { value: v.v } : v.kind === "fn" ? { function: v.name, arguments: v.args } : { keyword: "empty" })) } }
    : n.kind === "not" ? { operator: "not", clauses: [node(n.a)] }
    : { operator: n.kind, clauses: [node(n.a), node(n.b)] };
  return { ...(q.where ? { where: node(q.where) } : {}), orderBy: { fields: q.orderBy.map((o) => ({ field: { name: o.field }, direction: o.dir })) } };
}
