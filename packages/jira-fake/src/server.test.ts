import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES_DIR, loadSites, type Site } from "./index.js";
import { createFakeJira, type FakeJira, type FakeJiraOptions } from "./server.js";

// The fake Jira is what the sync's unit tests and e2e run against (design §15), so each block
// here holds one behaviour the sync depends on to the shape real Jira has: if the fake drifts,
// the sync passes its tests and fails on a real site. Requests go over HTTP with fetch, as the
// sync's REST transport will send them.

const SITES = loadSites();
const NOW = Date.parse("2026-10-24T08:00:00.000Z");
const ME = "5b10ac8d82e05b22cc7d4ef5";
const JANE = "5b10a2844c20165700ede21g";
const BOT = "70121:9d2c7e1b-4f3a-4c8e-b7a6-2e1f0d9c8b7a";

let open: FakeJira[] = [];
let clock = NOW;
afterEach(async () => {
  await Promise.all(open.map((f) => f.close()));
  open = [];
  clock = NOW;
});

// The sites script faults (a 429 on the 3rd search, …); only the fault tests keep them.
async function fake(name: string, opts: FakeJiraOptions = {}, keepFaults = false): Promise<FakeJira> {
  const site = SITES.get(name)!;
  const f = await createFakeJira(keepFaults ? site : { ...site, faults: [] }, { now: () => new Date(clock), ...opts });
  open.push(f);
  return f;
}

type Res = { status: number; headers: Headers; body: any };
async function call(f: FakeJira, method: string, path: string, o: { body?: unknown; raw?: string; auth?: string | null; gateway?: boolean } = {}): Promise<Res> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const auth = o.auth === undefined ? f.authorization() : o.auth;
  if (auth) headers.Authorization = auth;
  if (o.body !== undefined || o.raw !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${o.gateway ? f.gatewayUrl : f.url}${path}`, { method, headers, body: o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body)) });
  const text = await res.text();
  let body: unknown = text;
  try { body = text ? JSON.parse(text) : undefined; } catch { /* plain text */ }
  return { status: res.status, headers: res.headers, body };
}
const get = (f: FakeJira, path: string, o?: Parameters<typeof call>[3]) => call(f, "GET", path, o);
const post = (f: FakeJira, path: string, body: unknown, o?: Parameters<typeof call>[3]) => call(f, "POST", path, { ...o, body });
const put = (f: FakeJira, path: string, body: unknown, o?: Parameters<typeof call>[3]) => call(f, "PUT", path, { ...o, body });
const search = async (f: FakeJira, jql: string, extra: Record<string, unknown> = {}) => post(f, "/rest/api/3/search/jql", { jql, ...extra });
const keys = (r: Res) => (r.body.issues as { key: string }[]).map((i) => i.key);
const issueOf = (f: FakeJira, key: string) => f.site.issues.find((i) => i.key === key)!;

describe("auth", () => {
  const basic = (email: string, token: string) => `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
  // [label, site, credential, via gateway, path, expected status]
  const rows: [string, string, (f: FakeJira) => string | null, boolean, string, number][] = [
    ["classic token on the site URL", "cloud-scrum-company", (f) => f.authorization("classic"), false, "/rest/api/3/myself", 200],
    ["scoped token on the site URL is refused", "cloud-scrum-company", (f) => f.authorization("scoped"), false, "/rest/api/3/myself", 401],
    ["scoped token through /ex/jira/{cloudId}", "cloud-scrum-company", (f) => f.authorization("scoped"), true, "/rest/api/3/myself", 200],
    ["classic token through the gateway is refused", "cloud-scrum-company", (f) => f.authorization("classic"), true, "/rest/api/3/myself", 401],
    ["a wrong token", "cloud-scrum-company", () => basic("ujjwal@example.com", "nope"), false, "/rest/api/3/myself", 401],
    ["no credentials", "cloud-scrum-company", () => null, false, "/rest/api/3/myself", 401],
    ["a Bearer token on Cloud", "cloud-scrum-company", (f) => f.authorization("pat"), false, "/rest/api/3/myself", 401],
    ["Data Center PAT as Bearer", "dc-v2-wiki", (f) => f.authorization("pat"), false, "/rest/api/2/myself", 200],
    ["Data Center refuses a wrong PAT", "dc-v2-wiki", () => "Bearer nope", false, "/rest/api/2/myself", 401],
    ["Data Center refuses Basic", "dc-v2-wiki", (f) => basic(f.credentials.email, f.credentials.classicToken), false, "/rest/api/2/myself", 401],
  ];
  test.each(rows)("%s", async (_label, site, cred, gateway, path, status) => {
    const f = await fake(site);
    expect((await get(f, path, { auth: cred(f), gateway })).status).toBe(status);
  });

  test("credentials come from the options", async () => {
    const f = await fake("cloud-scrum-company", { credentials: { email: "bot@example.com", classicToken: "t-1" } });
    expect((await get(f, "/rest/api/3/myself", { auth: basic("bot@example.com", "t-1") })).status).toBe(200);
    expect((await get(f, "/rest/api/3/myself", { auth: basic("ujjwal@example.com", "fake-classic-token") })).status).toBe(401);
  });

  test("a scoped token with only classic scopes is refused on Agile, and the gateway's self links stay on the gateway", async () => {
    const f = await fake("cloud-scrum-company", { credentials: { scopes: ["read:jira-work", "write:jira-work"] } });
    const agile = await get(f, "/rest/agile/1.0/board?projectKeyOrId=PAY", { auth: f.authorization("scoped"), gateway: true });
    expect(agile).toMatchObject({ status: 401, body: { message: "Unauthorized; scope does not match" } });
    const me = await get(f, "/rest/api/3/myself", { auth: f.authorization("scoped"), gateway: true });
    expect(me.body.self.startsWith(`${f.gatewayUrl}/rest/api/3/`)).toBe(true);
    const granular = await fake("cloud-scrum-company", { credentials: { scopes: ["read:board-scope:jira-software", "read:project:jira"] } });
    expect((await get(granular, "/rest/agile/1.0/board?projectKeyOrId=PAY", { auth: granular.authorization("scoped"), gateway: true })).status).toBe(200);
  });

  test("each Agile call needs its own granular scopes: the board list, its configuration and features, its sprints", async () => {
    const statuses = async (scopes: string[]) => {
      const f = await fake("cloud-scrum-company", { credentials: { scopes } });
      const o = { auth: f.authorization("scoped"), gateway: true };
      return [
        (await get(f, "/rest/agile/1.0/board?projectKeyOrId=PAY", o)).status,
        (await get(f, "/rest/agile/1.0/board/12/configuration", o)).status,
        (await get(f, "/rest/agile/1.0/board/12/features", o)).status,
        (await get(f, "/rest/agile/1.0/board/12/sprint?state=active", o)).status,
        (await get(f, "/rest/api/3/myself", o)).status,
      ];
    };
    expect(await statuses(["read:board-scope:jira-software", "read:project:jira"])).toEqual([200, 401, 401, 401, 200]);
    expect(await statuses(["read:board-scope:jira-software", "read:project:jira", "read:board-scope.admin:jira-software"])).toEqual([200, 200, 200, 401, 200]);
    expect(await statuses(["read:board-scope:jira-software", "read:project:jira", "read:board-scope.admin:jira-software", "read:sprint:jira-software"])).toEqual([200, 200, 200, 200, 200]);
  });

  test("tenant_info gives the cloudId without credentials; Data Center has none", async () => {
    const f = await fake("cloud-scrum-company");
    expect(await get(f, "/_edge/tenant_info", { auth: null })).toMatchObject({ status: 200, body: { cloudId: SITES.get("cloud-scrum-company")!.cloudId } });
    expect((await get(await fake("dc-v2-wiki"), "/_edge/tenant_info", { auth: null })).status).toBe(404);
  });
});

describe("identity and discovery", () => {
  test("myself: accountId and time zone on Cloud, name/key on Data Center, the site zone when the user's is hidden", async () => {
    const cloud = await get(await fake("cloud-scrum-company"), "/rest/api/3/myself");
    expect(cloud.body).toMatchObject({ accountId: ME, timeZone: "Asia/Kolkata", displayName: "Ujjwal Solanki" });
    const dc = await get(await fake("dc-v2-wiki"), "/rest/api/2/myself");
    expect(dc.body).toMatchObject({ name: "usolanki", key: "JIRAUSER10100" });
    expect(dc.body.accountId).toBeUndefined();
    const jwm = await fake("cloud-jwm-noboard");
    jwm.site.users.find((u) => u.accountId === ME)!.timeZone = undefined;
    const issue = await get(jwm, "/rest/api/3/issue/MKT-2?fields=reporter");
    expect(issue.body.fields.reporter.timeZone).toBe("Europe/Berlin");
  });

  test("v2 serverInfo says Cloud only on Cloud", async () => {
    const cloud = await fake("cloud-kanban-team");
    expect((await get(cloud, "/rest/api/2/serverInfo")).body.deploymentType).toBe("Cloud");
    // The site's URL, also through the gateway (it names the site, not the API host).
    expect((await get(cloud, "/rest/api/2/serverInfo", { auth: cloud.authorization("scoped"), gateway: true })).body.baseUrl).toBe("https://acme.atlassian.net");
    const dc = await get(await fake("dc-v2-wiki"), "/rest/api/2/serverInfo");
    expect(dc.body).toMatchObject({ version: "9.12.15", serverTime: "2026-10-24T08:00:00.000+0000" });
    expect("deploymentType" in dc.body).toBe(false);
  });

  test("projects: style, simplified, every key, issue types and hierarchy", async () => {
    const f = await fake("cloud-kanban-team");
    const s = await get(f, "/rest/api/3/project/search?keys=OPS");
    expect(s.body.values.map((p: { key: string; style: string; simplified: boolean }) => [p.key, p.style, p.simplified])).toEqual([["OPS", "next-gen", true]]);
    expect((await get(f, "/rest/api/3/project/OPS?expand=projectKeys")).body.projectKeys).toEqual(["OPS"]);
    const types = await get(f, "/rest/api/3/issuetype/project?projectId=10200");
    expect(types.body.map((t: { name: string; hierarchyLevel: number }) => [t.name, t.hierarchyLevel])).toEqual([["Task", 0], ["Bug", 0], ["Subtask", -1], ["Epic", 1]]);
    const h = await get(f, "/rest/api/3/project/10200/hierarchy");
    expect(h.body.hierarchy.map((l: { level: number; issueTypes: { id: number }[] }) => [l.level, l.issueTypes.map((t) => t.id)])).toEqual([[0, [10200, 10201]], [1, [10203]], [-1, [10202]]]);
    expect((await get(f, "/rest/api/3/project/NOPE")).status).toBe(404);
  });

  test("project statuses come per issue type, each with its category (or No Category)", async () => {
    const scrum = await get(await fake("cloud-scrum-company"), "/rest/api/3/project/PAY/statuses");
    const bug = scrum.body.find((t: { name: string }) => t.name === "Bug");
    expect(bug.statuses.map((s: { name: string; statusCategory: { key: string } }) => `${s.name}:${s.statusCategory.key}`)).toEqual(["To Do:new", "In Progress:indeterminate", "Code Review:indeterminate", "QA:indeterminate", "Done:done", "Won't Do:done"]);
    expect(scrum.body.find((t: { name: string }) => t.name === "Story").statuses).toHaveLength(9);
    const kanban = await get(await fake("cloud-kanban-team"), "/rest/api/3/project/OPS/statuses");
    expect(kanban.body[0].statuses.find((s: { name: string }) => s.name === "Triage").statusCategory.key).toBe("undefined");
  });

  test("fields, resolutions, permissions and the board filter", async () => {
    const f = await fake("cloud-scrum-company");
    const fields = (await get(f, "/rest/api/3/field")).body as { id: string; schema?: { custom?: string } }[];
    expect(fields.find((x) => x.schema?.custom === "com.pyxis.greenhopper.jira:gh-sprint")?.id).toBe("customfield_10020");
    expect((await get(f, "/rest/api/3/resolution/search")).body.values.map((r: { name: string }) => r.name)).toEqual(["Done", "Won't Do", "Duplicate", "Cannot Reproduce"]);
    const perms = await get(await fake("cloud-jwm-noboard"), "/rest/api/3/mypermissions?projectKey=MKT&permissions=BROWSE_PROJECTS,TRANSITION_ISSUES,ASSIGN_ISSUES");
    expect(Object.fromEntries(Object.entries(perms.body.permissions).map(([k, v]) => [k, (v as { havePermission: boolean }).havePermission]))).toEqual({ BROWSE_PROJECTS: true, TRANSITION_ISSUES: false, ASSIGN_ISSUES: false });
    expect((await get(f, "/rest/api/3/mypermissions?projectKey=PAY")).status).toBe(400);
    expect((await get(f, "/rest/api/3/filter/10041")).body.jql).toBe("project = PAY AND issuetype = Bug ORDER BY Rank ASC");
    f.site.boards[1]!.filter.shared = false;
    expect((await get(f, "/rest/api/3/filter/10041")).status).toBe(400);
  });

  test("statuses/search and POST /workflows need admin (401, as the spec documents)", async () => {
    const user = await fake("cloud-scrum-company");
    expect((await get(user, "/rest/api/3/statuses/search?projectId=10100")).status).toBe(401);
    expect((await post(user, "/rest/api/3/workflows", { workflowNames: ["PAY Bug workflow"] })).status).toBe(401);
    const admin = await fake("cloud-scrum-company", { admin: true });
    expect((await get(admin, "/rest/api/3/statuses/search?projectId=10100")).body.values).toHaveLength(9);
    const wf = await post(admin, "/rest/api/3/workflows", { projectAndIssueTypes: [{ projectId: "10100", issueTypeId: "10004" }] });
    const t = wf.body.workflows[0].transitions as { id: string; type: string; links: { fromStatusReference: string }[] }[];
    expect(t.find((x) => x.id === "81")?.type).toBe("GLOBAL");
    expect(t.find((x) => x.id === "52")?.links.map((l) => l.fromStatusReference)).toEqual(["10003", "10004"]);
  });

  test("boards: list, columns (Kanban's first column is always Backlog), estimation only for Scrum, features, sprints", async () => {
    const f = await fake("cloud-scrum-company");
    expect((await get(f, "/rest/agile/1.0/board?projectKeyOrId=PAY")).body.values.map((b: { id: number; type: string }) => [b.id, b.type])).toEqual([[12, "scrum"], [13, "kanban"]]);
    const scrum = await get(f, "/rest/agile/1.0/board/12/configuration");
    expect(scrum.body.estimation.field.fieldId).toBe("customfield_10028");
    expect(scrum.body.columnConfig.columns.at(-1).statuses.map((s: { id: string }) => s.id)).toEqual(["10006", "10007"]);
    const kanbanOff = await get(f, "/rest/agile/1.0/board/13/configuration");
    expect(kanbanOff.body.columnConfig.columns[0]).toEqual({ name: "Backlog", statuses: [] });
    expect(kanbanOff.body.estimation).toBeUndefined();
    f.site.boards[1]!.columns.shift(); // a model without the placeholder still answers with it
    expect((await get(f, "/rest/agile/1.0/board/13/configuration")).body.columnConfig.columns[0]).toEqual({ name: "Backlog", statuses: [] });
    const ops = await fake("cloud-kanban-team");
    ops.site.boards[0]!.estimationFieldId = "customfield_10016";
    const on = await get(ops, "/rest/agile/1.0/board/34/configuration");
    expect(on.body.estimation).toBeUndefined();
    expect(on.body.columnConfig.columns[0].statuses.map((s: { id: string }) => s.id)).toEqual(["10100"]);
    expect(on.body.subQuery.query).toBe("resolution = EMPTY OR resolution changed AFTER -2w");
    const features = (await get(ops, "/rest/agile/1.0/board/34/features")).body.features as { boardFeature: string; state: string }[];
    expect(features.find((x) => x.boardFeature === "BACKLOG")?.state).toBe("ENABLED");
    expect((await get(f, "/rest/agile/1.0/board/12/sprint?state=active,future")).body.values.map((s: { id: number }) => s.id)).toEqual([87, 89, 88]);
    expect((await get(f, "/rest/agile/1.0/board/13/sprint")).status).toBe(400);
  });

  test("the software backlog pages with a token: Scrum = not in an open sprint and not done, Kanban = the first column", async () => {
    const f = await fake("cloud-scrum-company");
    const scrum = await get(f, "/rest/software/1.0/board/12/backlog?fields=summary");
    expect(keys(scrum)).toEqual(["PAY-327", "PAY-300"].sort((a, b) => f.site.issues.findIndex((i) => i.key === a) - f.site.issues.findIndex((i) => i.key === b)));
    const ops = await fake("cloud-kanban-team");
    const first = await get(ops, "/rest/software/1.0/board/34/backlog?maxResults=1");
    expect(first.body).toMatchObject({ isLast: true });
    expect(keys(first)).toEqual(["OPS-3"]);
    expect((await get(f, "/rest/software/1.0/board/13/backlog")).status).toBe(400);
    for (let n = 0; n < 3; n++) ops.site.issues.push({ ...structuredClone(issueOf(ops, "OPS-3")), id: String(20000 + n), key: `OPS-${100 + n}` });
    const p1 = await get(ops, "/rest/software/1.0/board/34/backlog?maxResults=2");
    expect([p1.body.isLast, p1.body.issues.length, typeof p1.body.nextPageToken]).toEqual([false, 2, "string"]);
    const p2 = await get(ops, `/rest/software/1.0/board/34/backlog?maxResults=2&nextPageToken=${p1.body.nextPageToken}`);
    expect([p2.body.isLast, p2.body.issues.length, p2.body.nextPageToken]).toEqual([true, 2, undefined]);
  });
});

describe("search", () => {
  // [site, jql, expected keys in order]
  const rows: [string, string, string[]][] = [
    ["cloud-scrum-company", "project = PAY AND sprint in openSprints() AND assignee = currentUser() ORDER BY key", ["PAY-322", "PAY-323", "PAY-324", "PAY-328", "PAY-330"]],
    ["cloud-scrum-company", "project = PAY AND sprint in futureSprints()", ["PAY-326"]],
    ["cloud-scrum-company", "project = PAY AND (assignee = currentUser() OR assignee is EMPTY) AND sprint = 87 ORDER BY key", ["PAY-318", "PAY-322", "PAY-323", "PAY-324", "PAY-328", "PAY-330"]],
    ["cloud-scrum-company", `project in (PAY) AND statusCategory != Done AND assignee = ${JANE} ORDER BY key`, ["PAY-300", "PAY-321", "PAY-325", "PAY-329"]],
    ["cloud-scrum-company", `project = PAY AND status in ("Code Review", QA)`, ["PAY-324"]],
    // myself is in Asia/Kolkata (UTC+5:30): 14:44 there is 09:14 UTC, PAY-318's `updated`, to the minute.
    ["cloud-scrum-company", `project = PAY AND updated >= "2026-10-22 14:44" ORDER BY updated ASC`, ["PAY-318", "PAY-330", "PAY-322", "PAY-325"]],
    ["cloud-scrum-company", `project = PAY AND updated >= "2026-10-22 14:45" ORDER BY updated ASC`, ["PAY-330", "PAY-322", "PAY-325"]],
    ["cloud-scrum-company", "project = PAY AND updated >= -1d ORDER BY updated DESC", ["PAY-325"]],
    ["cloud-scrum-company", "project = PAY AND updated >= -1500m ORDER BY updated DESC", ["PAY-325", "PAY-322"]],
    ["cloud-scrum-company", `project = PAY AND issuetype not in (Epic, Sub-task, Bug) AND assignee = currentUser() AND statusCategory = "To Do" ORDER BY key`, ["PAY-322", "PAY-326", "PAY-327"]],
    ["cloud-scrum-company", "id in (10426, 10423) ORDER BY key", ["PAY-318", "PAY-321"]],
    ["cloud-scrum-company", "key in (PAY-318, PAY-331, PAY-332)", ["PAY-318"]],
    ["cloud-scrum-company", "parent = PAY-300 ORDER BY key", ["PAY-318", "PAY-321", "PAY-322"]],
    ["cloud-scrum-company", "project = PAY AND resolution = EMPTY AND sprint = 87 AND assignee = currentUser() ORDER BY key", ["PAY-322", "PAY-323", "PAY-324", "PAY-330"]],
    ["cloud-scrum-company", `project = PAY AND NOT (status = "To Do" OR status = Backlog) AND assignee = currentUser() ORDER BY key`, ["PAY-324", "PAY-328", "PAY-330"]],
    ["cloud-scrum-company", "sprint = 89 OR key = PAY-300 ORDER BY Rank", ["PAY-300", "PAY-325"]],
    ["cloud-scrum-company", `assignee = ${JANE} ORDER BY key DESC`, ["PAY-329", "PAY-325", "PAY-321", "PAY-300"]],
    // CHANGE-3131: an unknown field, function or value gives zero results, never an error.
    ["cloud-scrum-company", "project = PAY AND bogus = 1", []],
    ["cloud-scrum-company", "project = PAY AND sprint = 999", []],
    ["cloud-scrum-company", "project = PAY AND assignee in membersOf(devs)", []],
    ["cloud-kanban-team", "key = PAY-112", ["OPS-7"]],
    ["cloud-kanban-team", `project = OPS AND statusCategory = "No Category"`, ["OPS-5"]],
    ["cloud-kanban-team", "project = OPS AND (statusCategory != Done OR updated >= -14d) ORDER BY key", ["OPS-1", "OPS-2", "OPS-3", "OPS-5", "OPS-7"]],
    ["cloud-jwm-noboard", "project = MKT AND statusCategory != Done AND assignee is EMPTY", ["MKT-2"]],
  ];
  test.each(rows)("%s: %s", async (site, jql, expected) => {
    const f = await fake(site);
    const r = await search(f, jql, { fields: ["key"] });
    expect(r.status).toBe(200);
    expect(keys(r)).toEqual(expected);
  });

  test("approximate-count counts what search finds, refuses unbounded JQL, and is Cloud only", async () => {
    const f = await fake("cloud-scrum-company");
    const all = await search(f, "project = PAY", { maxResults: 5000 });
    expect(await post(f, "/rest/api/3/search/approximate-count", { jql: "project = PAY" })).toMatchObject({ status: 200, body: { count: all.body.issues.length } });
    expect((await post(f, "/rest/api/3/search/approximate-count", { jql: "project = PAY AND assignee = currentUser()" })).body.count).toBe(keys(await search(f, "project = PAY AND assignee = currentUser()", { maxResults: 100 })).length);
    expect((await post(f, "/rest/api/3/search/approximate-count", { jql: "ORDER BY key" })).status).toBe(400);
    expect((await post(await fake("dc-v2-wiki"), "/rest/api/2/search/approximate-count", { jql: "project = PAY" }, { auth: undefined })).status).toBe(404);
  });

  test("GET takes the same query as POST", async () => {
    const f = await fake("cloud-scrum-company");
    const r = await get(f, `/rest/api/3/search/jql?jql=${encodeURIComponent("parent = PAY-300 ORDER BY key")}&fields=key`);
    expect(keys(r)).toEqual(["PAY-318", "PAY-321", "PAY-322"]);
  });

  test("jql/parse reports what search silently drops; syntax errors and unbounded queries are 400", async () => {
    const f = await fake("cloud-scrum-company");
    const parsed = await post(f, "/rest/api/3/jql/parse?validation=strict", { queries: ["project = PAY AND bogus = 1", "project = PAY AND sprint = 999", "project = PAY AND sprint in openSprints()"] });
    expect(parsed.body.queries.map((q: { errors?: string[] }) => q.errors ?? [])).toEqual([
      ["Field 'bogus' does not exist or you do not have permission to view it."],
      ["Sprint with name or id '999' does not exist or you do not have permission to view it."],
      [],
    ]);
    expect((await search(f, "project = ")).status).toBe(400);
    expect((await search(f, "project = PAY AND")).body.errorMessages[0]).toStartWith("Error in the JQL Query");
    expect(await search(f, "ORDER BY updated ASC")).toMatchObject({ status: 400, body: { errorMessages: ["Unbounded JQL queries are not allowed here. Please add a search restriction to your query."] } });
  });

  test("fields: id only by default, *all, *navigable, explicit, and -exclusion", async () => {
    const f = await fake("cloud-scrum-company");
    const one = async (fields?: string[]) => (await search(f, "key = PAY-318", fields ? { fields } : {})).body.issues[0];
    expect(await one()).toEqual({ id: "10423" });
    expect(Object.keys((await one(["key"])).fields)).toEqual([]);
    expect(Object.keys((await one(["summary", "status"])).fields).sort()).toEqual(["status", "summary"]);
    const all = Object.keys((await one(["*all"])).fields);
    expect(all).toContain("comment");
    expect(all).toContain("customfield_10020");
    const nav = Object.keys((await one(["*navigable"])).fields);
    expect(nav).toContain("description");
    expect(nav).not.toContain("comment");
    expect(Object.keys((await one(["*all,-comment"])).fields)).not.toContain("comment");
    const minus = Object.keys((await one(["-description"])).fields);
    expect([minus.includes("description"), minus.includes("summary"), minus.includes("comment")]).toEqual([false, true, false]);
  });

  test("embedded comments stop at 20 and changelog at 40; the issue's own endpoints have all", async () => {
    const f = await fake("cloud-scrum-company");
    const i = issueOf(f, "PAY-318");
    for (let n = 0; n < 25; n++) i.comments.push({ ...structuredClone(i.comments[0]!), id: String(50000 + n) });
    for (let n = 0; n < 45; n++) i.changelog.push({ ...structuredClone(i.changelog[0]!), id: String(60000 + n), created: `2026-10-23T0${n % 10}:00:00.000+0000` });
    const r = (await search(f, "key = PAY-318", { fields: ["comment"], expand: "changelog" })).body.issues[0];
    expect([r.fields.comment.comments.length, r.fields.comment.total]).toEqual([20, 27]);
    expect([r.changelog.histories.length, r.changelog.total, r.changelog.histories[0].id]).toEqual([40, 46, "60044"]);
    expect((await get(f, "/rest/api/3/issue/PAY-318?fields=comment")).body.fields.comment.comments).toHaveLength(27);
  });

  test("properties (at most 5) and reconcileIssues (at most 50)", async () => {
    const f = await fake("cloud-scrum-company");
    const r = await search(f, "key = PAY-324", { properties: ["hivemind"] });
    expect(r.body.issues[0].properties.hivemind.branch).toBe("PAY-324-idempotency-keys");
    expect((await search(f, "key = PAY-324", { properties: ["a", "b", "c", "d", "e", "f"] })).status).toBe(400);
    expect((await search(f, "key = PAY-324", { reconcileIssues: Array.from({ length: 51 }, (_, n) => n) })).status).toBe(400);
  });

  test("paging: opaque nextPageToken, isLast, no total; tokens belong to their query", async () => {
    const f = await fake("cloud-scrum-company");
    const jql = "project = PAY ORDER BY key";
    const seen: string[] = [];
    let token: string | undefined;
    const pages: [boolean, number][] = [];
    do {
      const r = await search(f, jql, { fields: ["key"], maxResults: 5, ...(token ? { nextPageToken: token } : {}) });
      expect("total" in r.body).toBe(false);
      seen.push(...keys(r));
      pages.push([r.body.isLast, r.body.issues.length]);
      token = r.body.nextPageToken;
    } while (token);
    expect(pages).toEqual([[false, 5], [false, 5], [true, 2]]);
    expect(seen).toHaveLength(12);
    const first = await search(f, jql, { fields: ["key"], maxResults: 5 });
    expect((await search(f, "project = PAY ORDER BY updated", { nextPageToken: first.body.nextPageToken })).status).toBe(400);
  });

  test("maxResults is capped at 5000 for id/key-only pages and 100 otherwise", async () => {
    const f = await fake("cloud-scrum-company");
    const base = issueOf(f, "PAY-327");
    for (let n = 0; n < 150; n++) f.site.issues.push({ ...structuredClone(base), id: String(70000 + n), key: `PAY-${1000 + n}` });
    expect((await search(f, "project = PAY AND status = Backlog", { maxResults: 1000 })).body.issues).toHaveLength(151);
    expect((await search(f, "project = PAY AND status = Backlog", { maxResults: 1000, fields: ["summary"] })).body.issues).toHaveLength(100);
  });

  test("a write shows in search only after the lag, unless reconcileIssues names it", async () => {
    const f = await fake("cloud-scrum-company", { searchLagMs: 5000 });
    expect((await post(f, "/rest/api/3/issue/PAY-322/transitions", { transition: { id: "21" } })).status).toBe(204);
    const jql = `key = PAY-322 AND status = "In Progress"`;
    expect(keys(await search(f, jql, { fields: ["key"] }))).toEqual([]);
    expect(keys(await search(f, jql, { fields: ["key"], reconcileIssues: [10427] }))).toEqual(["PAY-322"]);
    clock += 5001;
    expect(keys(await search(f, jql, { fields: ["key"] }))).toEqual(["PAY-322"]);
  });

  test("Cloud answers 410 on the old offset searches", async () => {
    const f = await fake("cloud-kanban-team");
    for (const [m, p] of [["GET", "/rest/api/3/search?jql=project%3DOPS"], ["POST", "/rest/api/3/search"], ["GET", "/rest/api/2/search?jql=project%3DOPS"]] as const) {
      const r = await call(f, m, p, m === "POST" ? { body: { jql: "project = OPS" } } : {});
      expect([m, p, r.status, r.body.errorMessages[0].includes("CHANGE-2046")]).toEqual([m, p, 410, true]);
    }
  });

  test("Data Center: offset search with total, navigable fields and wiki bodies; invalid values are 400 unless validateQuery=false", async () => {
    const f = await fake("dc-v2-wiki");
    const r = await get(f, `/rest/api/2/search?jql=${encodeURIComponent("project = CORE AND assignee = currentUser()")}`);
    expect(r.body).toMatchObject({ startAt: 0, maxResults: 50, total: 1 });
    expect(r.body.issues[0].fields.description).toStartWith("h3. Steps");
    expect(r.body.issues[0].fields.assignee.name).toBe("usolanki");
    const page = await post(f, "/rest/api/2/search", { jql: "project = CORE ORDER BY key", startAt: 1, maxResults: 1, fields: ["summary"] });
    expect([page.body.total, page.body.issues.map((i: { key: string }) => i.key)]).toEqual([2, ["CORE-2"]]);
    const bad = `key in (CORE-1, CORE-99)`;
    expect(await get(f, `/rest/api/2/search?jql=${encodeURIComponent(bad)}`)).toMatchObject({ status: 400, body: { errorMessages: ["An issue with key 'CORE-99' does not exist for field 'key'."] } });
    const lenient = await get(f, `/rest/api/2/search?validateQuery=false&jql=${encodeURIComponent(bad)}`);
    expect([lenient.body.issues.map((i: { key: string }) => i.key), lenient.body.warningMessages.length]).toEqual([["CORE-1"], 1]);
  });

  test("Data Center has no token search, bulkfetch, jql/match, changelog bulkfetch, per-issue changelog or v3", async () => {
    const f = await fake("dc-v2-wiki");
    const rows: [string, string][] = [["POST", "/rest/api/2/search/jql"], ["POST", "/rest/api/2/issue/bulkfetch"], ["POST", "/rest/api/2/jql/match"], ["POST", "/rest/api/2/changelog/bulkfetch"], ["GET", "/rest/api/2/issue/CORE-1/changelog"], ["GET", "/rest/api/3/myself"], ["GET", "/rest/software/1.0/board/1/backlog"]];
    for (const [m, p] of rows) expect([m, p, (await call(f, m, p, m === "POST" ? { body: {} } : {})).status]).toEqual([m, p, 404]);
    expect((await get(f, "/rest/api/2/issue/CORE-1?expand=changelog")).body.changelog.total).toBe(0);
  });

  test("restricted and deleted issues never appear", async () => {
    const f = await fake("cloud-scrum-company");
    const all = keys(await search(f, "project = PAY", { fields: ["key"], maxResults: 100 }));
    expect([all.includes("PAY-331"), all.includes("PAY-332"), all.length]).toEqual([false, false, 12]);
  });
});

describe("bulk reads", () => {
  test("bulkfetch: ascending id, restricted/deleted/unknown omitted silently, moved keys resolve", async () => {
    const f = await fake("cloud-scrum-company");
    const r = await post(f, "/rest/api/3/issue/bulkfetch", { issueIdsOrKeys: ["PAY-331", "PAY-332", "10426", "PAY-999", "pay-318"], fields: ["summary"] });
    expect([r.body.issues.map((i: { key: string }) => i.key), r.body.issueErrors]).toEqual([["PAY-318", "PAY-321"], []]);
    const moved = await post(await fake("cloud-kanban-team"), "/rest/api/3/issue/bulkfetch", { issueIdsOrKeys: ["PAY-112"], fields: ["summary"] });
    expect(moved.body.issues.map((i: { id: string; key: string }) => [i.id, i.key])).toEqual([["10212", "OPS-7"]]);
  });

  test("bulkfetch reports injected retriable failures in issueErrors, not as missing", async () => {
    const f = await fake("cloud-scrum-company", { issueErrors: { "PAY-322": "Retry later." } });
    const r = await post(f, "/rest/api/3/issue/bulkfetch", { issueIdsOrKeys: ["PAY-322", "PAY-318"], fields: ["summary"] });
    expect([r.body.issues.map((i: { key: string }) => i.key), r.body.issueErrors]).toEqual([["PAY-318"], [{ id: "10427", errorMessage: "Retry later." }]]);
  });

  // [label, ids, fields, expand, status]
  const sizes: [string, number, string[] | undefined, string[] | undefined, number][] = [
    ["100 with the default fields", 100, undefined, undefined, 200],
    ["101 with the default fields", 101, undefined, undefined, 400],
    ["1000 with explicit single-value fields", 1000, ["updated", "status", "assignee"], undefined, 200],
    ["1001 with explicit single-value fields", 1001, ["updated"], undefined, 400],
    ["101 with a multi-value field", 101, ["summary", "comment"], undefined, 400],
    ["101 with *navigable", 101, ["*navigable"], undefined, 400],
    ["101 with only exclusions", 101, ["-description"], undefined, 400],
    ["101 with expand=changelog", 101, ["summary"], ["changelog"], 400],
  ];
  test.each(sizes)("bulkfetch size limit: %s", async (_label, n, fields, expand, status) => {
    const f = await fake("cloud-scrum-company");
    const ids = Array.from({ length: n }, (_, k) => `PAY-${5000 + k}`);
    expect((await post(f, "/rest/api/3/issue/bulkfetch", { issueIdsOrKeys: ids, ...(fields ? { fields } : {}), ...(expand ? { expand } : {}) })).status).toBe(status);
  });

  test("jql/match: per-query matches among visible ids, 10 queries × 50 ids at most", async () => {
    const f = await fake("cloud-scrum-company");
    const r = await post(f, "/rest/api/3/jql/match", { jqls: ["project = PAY AND assignee = currentUser()", "statusCategory = Done", "project = ", "project = PAY AND bogus = 1"], issueIds: [10423, 10427, 10433, 10436] });
    // A syntax error is reported; an unknown field matches nothing silently, as search does (CHANGE-3131).
    expect(r.body.matches.map((m: { matchedIssues: number[]; errors: string[] }) => [m.matchedIssues, m.errors.length])).toEqual([[[10427, 10433], 0], [[10433], 0], [[], 1], [[], 0]]);
    expect((await post(f, "/rest/api/3/jql/match", { jqls: Array(11).fill("project = PAY"), issueIds: [10423] })).status).toBe(400);
    expect((await post(f, "/rest/api/3/jql/match", { jqls: ["project = PAY"], issueIds: Array.from({ length: 51 }, (_, k) => k) })).status).toBe(400);
  });

  test("changelog/bulkfetch: filtered by fieldIds, oldest first, token paging, size limits", async () => {
    const ops = await fake("cloud-kanban-team");
    const r = await post(ops, "/rest/api/3/changelog/bulkfetch", { issueIdsOrKeys: ["OPS-7"], fieldIds: ["status"] });
    expect(r.body.issueChangeLogs).toHaveLength(1);
    expect(r.body.issueChangeLogs[0].changeHistories[0].items.map((i: { fieldId: string; toString: string }) => [i.fieldId, i.toString])).toEqual([["status", "In Progress"]]);
    const f = await fake("cloud-scrum-company");
    await put(f, "/rest/api/3/issue/PAY-318/assignee", { accountId: ME });
    clock += 60_000;
    expect((await post(f, "/rest/api/3/issue/PAY-318/transitions", { transition: { id: "21" } })).status).toBe(204); // Start is assignee-only
    const all = await post(f, "/rest/api/3/changelog/bulkfetch", { issueIdsOrKeys: ["PAY-318", "PAY-331"], fieldIds: ["status", "assignee"] });
    expect(all.body.issueChangeLogs.map((l: { issueId: string }) => l.issueId)).toEqual(["10423"]);
    expect(all.body.issueChangeLogs[0].changeHistories.map((h: { items: { fieldId: string }[] }) => h.items[0]!.fieldId)).toEqual(["assignee", "assignee", "status"]);
    const p1 = await post(f, "/rest/api/3/changelog/bulkfetch", { issueIdsOrKeys: ["PAY-318"], maxResults: 2 });
    const p2 = await post(f, "/rest/api/3/changelog/bulkfetch", { issueIdsOrKeys: ["PAY-318"], maxResults: 2, nextPageToken: p1.body.nextPageToken });
    expect([p1.body.issueChangeLogs[0].changeHistories.length, p2.body.issueChangeLogs[0].changeHistories.length, p2.body.nextPageToken]).toEqual([2, 1, undefined]);
    expect((await post(f, "/rest/api/3/changelog/bulkfetch", { issueIdsOrKeys: Array(1001).fill("PAY-318") })).status).toBe(400);
    expect((await post(f, "/rest/api/3/changelog/bulkfetch", { issueIdsOrKeys: ["PAY-318"], fieldIds: Array.from({ length: 11 }, (_, k) => `f${k}`) })).status).toBe(400);
  });

  test("issue: moved keys resolve, restricted and deleted are 404", async () => {
    const ops = await fake("cloud-kanban-team");
    expect((await get(ops, "/rest/api/3/issue/PAY-112?fields=summary")).body.key).toBe("OPS-7");
    const f = await fake("cloud-scrum-company");
    for (const k of ["PAY-331", "PAY-332", "PAY-999"]) expect([k, (await get(f, `/rest/api/3/issue/${k}`)).status]).toEqual([k, 404]);
  });

  test("comments: offset paging, orderBy created only, restricted comments carry their visibility", async () => {
    const f = await fake("cloud-scrum-company");
    const page = await get(f, "/rest/api/3/issue/PAY-318/comment?startAt=1&maxResults=1");
    expect(page.body).toMatchObject({ startAt: 1, maxResults: 1, total: 2 });
    expect(page.body.comments.map((c: { id: string; visibility?: unknown }) => [c.id, c.visibility])).toEqual([["10024", { type: "role", value: "Developers" }]]);
    expect((await get(f, "/rest/api/3/issue/PAY-318/comment?orderBy=-created")).body.comments[0].id).toBe("10024");
    expect((await get(f, "/rest/api/3/issue/PAY-318/comment?orderBy=updated")).status).toBe(400);
  });

  test("the per-issue changelog is oldest first and pages by offset", async () => {
    const f = await fake("cloud-scrum-company");
    await put(f, "/rest/api/3/issue/PAY-318/assignee", { accountId: ME });
    const r = await get(f, "/rest/api/3/issue/PAY-318/changelog");
    expect(r.body).toMatchObject({ startAt: 0, total: 2, isLast: true });
    expect(r.body.values.map((h: { items: { to?: string }[] }) => h.items[0]!.to ?? null)).toEqual([null, ME]);
    const p = await get(f, "/rest/api/3/issue/PAY-318/changelog?startAt=0&maxResults=1");
    expect([p.body.isLast, p.body.values.length, typeof p.body.nextPage]).toEqual([false, 1, "string"]);
  });
});

describe("writes", () => {
  const tids = (r: Res) => (r.body.transitions as { id: string; isAvailable?: boolean }[]).map((t) => (t.isAvailable === false ? `${t.id}!` : t.id));
  // [label, site, key, query, expected transition ids ("!" = isAvailable:false)]
  const lists: [string, string, string, string, string[]][] = [
    ["from To Do: Start and the global Won't do", "cloud-scrum-company", "PAY-322", "", ["21", "81"]],
    ["an unmet assignee-only condition is hidden", "cloud-scrum-company", "PAY-329", "", ["81"]],
    ["includeUnavailableTransitions shows it as unavailable", "cloud-scrum-company", "PAY-329", "?includeUnavailableTransitions=true", ["21!", "81"]],
    ["an unmet users condition is hidden", "cloud-scrum-company", "PAY-330", "", ["81"]],
    ["includeUnavailableTransitions shows the users condition too", "cloud-scrum-company", "PAY-330", "?includeUnavailableTransitions=true", ["71!", "81"]],
    ["without TRANSITION_ISSUES the list is empty", "cloud-jwm-noboard", "MKT-1", "?includeUnavailableTransitions=true", []],
    ["a global transition to the current status is not offered", "cloud-kanban-team", "OPS-1", "", ["1", "3", "4", "5", "6"]],
  ];
  test.each(lists)("GET transitions: %s", async (_label, site, key, q, expected) => {
    const f = await fake(site);
    expect(tids(await get(f, `/rest/api/3/issue/${key}/transitions${q}`))).toEqual(expected);
  });

  test("GET transitions: screen fields only with expand=transitions.fields", async () => {
    const f = await fake("cloud-scrum-company");
    const plain = await get(f, "/rest/api/3/issue/PAY-322/transitions");
    expect(plain.body.transitions[1].fields).toBeUndefined();
    const r = await get(f, "/rest/api/3/issue/PAY-322/transitions?expand=transitions.fields");
    const wont = r.body.transitions.find((t: { id: string }) => t.id === "81");
    expect([wont.hasScreen, wont.isGlobal, wont.fields.resolution.required, wont.fields.resolution.allowedValues.map((v: { name: string }) => v.name)]).toEqual([true, true, true, ["Won't Do", "Duplicate", "Cannot Reproduce"]]);
  });

  // [label, site, key, body, expected 400 body]
  const refusals: [string, string, string, unknown, unknown][] = [
    ["no transition id", "cloud-scrum-company", "PAY-322", {}, { errorMessages: ["Missing 'transition' identifier"] }],
    ["not from the current status", "cloud-scrum-company", "PAY-322", { transition: { id: "41" } }, { errorMessages: ["Transition id '41' is not valid for this issue."] }],
    ["a condition refuses", "cloud-scrum-company", "PAY-329", { transition: { id: "21" } }, { errorMessages: [expect.stringContaining("workflow operation (Start) that is not valid for the current state of this issue (PAY-329)")] }],
    ["a required screen field is missing", "cloud-scrum-company", "PAY-322", { transition: { id: "81" } }, { errorMessages: [], errors: { resolution: "Resolution is required." } }],
    ["a field that is not on the screen", "cloud-scrum-company", "PAY-322", { transition: { id: "81" }, fields: { resolution: { name: "Won't Do" }, assignee: { accountId: ME } } }, { errorMessages: [], errors: { assignee: "Field 'assignee' cannot be set. It is not on the appropriate screen, or unknown." } }],
    ["a value the screen does not allow", "cloud-scrum-company", "PAY-322", { transition: { id: "81" }, fields: { resolution: { name: "Done" } } }, { errorMessages: [], errors: { resolution: "Could not find valid 'id' or 'name' in resolution object." } }],
    ["no TRANSITION_ISSUES", "cloud-jwm-noboard", "MKT-1", { transition: { id: "41" } }, { errorMessages: ["You do not have permission to transition this issue."] }],
  ];
  test.each(refusals)("POST transitions refused: %s", async (_label, site, key, body, expected) => {
    const f = await fake(site);
    const before = structuredClone(issueOf(f, key));
    const r = await post(f, `/rest/api/3/issue/${key}/transitions`, body);
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject(expected as object);
    expect(issueOf(f, key)).toEqual(before);
  });

  test("POST transitions: a validator field that is not on the screen answers with its own message", async () => {
    const f = await fake("cloud-scrum-company");
    delete f.site.workflows["PAY Story workflow"]!.transitions.find((t) => t.id === "71")!.condition;
    const r = await post(f, "/rest/api/3/issue/PAY-330/transitions", { transition: { id: "71" }, fields: { resolution: { name: "Done" } } });
    expect(r).toMatchObject({ status: 400, body: { errors: { fixVersions: "Fix Version/s is required." } } });
    const sent = await post(f, "/rest/api/3/issue/PAY-330/transitions", { transition: { id: "71" }, fields: { resolution: { name: "Done" }, fixVersions: [{ name: "2026.10" }] } });
    expect(sent.body.errors.fixVersions).toBe("Field 'fixVersions' cannot be set. It is not on the appropriate screen, or unknown.");
  });

  test("POST transitions: moves the status, stamps updated, records the change, applies properties, sets and clears the resolution", async () => {
    const f = await fake("cloud-scrum-company");
    expect((await post(f, "/rest/api/3/issue/PAY-322/transitions", { transition: { id: "21" }, properties: [{ key: "hivemind", value: { branch: "PAY-322-metrics" } }] })).status).toBe(204);
    let i = issueOf(f, "PAY-322");
    expect([i.status, i.updated, i.properties.hivemind, i.changelog.at(-1)!.items]).toEqual(["3", "2026-10-24T08:00:00.000+0000", { branch: "PAY-322-metrics" }, [{ field: "status", fieldId: "status", from: "10001", fromString: "To Do", to: "3", toString: "In Progress" }]]);
    clock += 60_000;
    const comment = { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Not needed." }] }] };
    expect((await post(f, "/rest/api/3/issue/PAY-322/transitions", { transition: { id: "81" }, fields: { resolution: { name: "Won't Do" } }, update: { comment: [{ add: { body: comment } }] } })).status).toBe(204);
    i = issueOf(f, "PAY-322");
    expect([i.status, i.resolution, i.comments.length, i.changelog.at(-1)!.items.map((x) => x.field)]).toEqual(["10007", "Won't Do", 1, ["status", "resolution"]]);
    expect((await post(f, "/rest/api/3/issue/PAY-322/transitions", { transition: { id: "91" } })).status).toBe(204);
    expect(issueOf(f, "PAY-322").resolution).toBeNull();
    const ops = await fake("cloud-kanban-team");
    await post(ops, "/rest/api/3/issue/OPS-1/transitions", { transition: { id: "5" } });
    expect(issueOf(ops, "OPS-1").resolution).toBe("Done");
    const search = await post(f, "/rest/api/3/search/jql", { jql: "key = PAY-322", fields: ["status", "updated"] });
    expect([search.body.issues[0].fields.status.name, search.body.issues[0].fields.updated]).toEqual(["To Do", "2026-10-24T08:01:00.000+0000"]);
  });

  // [label, site, key, body, expected status, expected assignee after]
  const assigns: [string, string, string, unknown, number, string | null][] = [
    ["to me", "cloud-scrum-company", "PAY-318", { accountId: ME }, 204, ME],
    ["unassign with null", "cloud-scrum-company", "PAY-321", { accountId: null }, 204, null],
    ["-1 is the automatic assignee (no project lead here: unassigned)", "cloud-scrum-company", "PAY-321", { accountId: "-1" }, 204, null],
    ["an unknown user", "cloud-scrum-company", "PAY-318", { accountId: "nobody" }, 400, null],
    ["no ASSIGN_ISSUES", "cloud-kanban-team", "OPS-3", { accountId: ME }, 403, null],
    ["no ASSIGN_ISSUES (Work Management)", "cloud-jwm-noboard", "MKT-2", { accountId: ME }, 403, null],
    ["Data Center by username", "dc-v2-wiki", "CORE-2", { name: "jdoe" }, 204, "jdoe"],
  ];
  test.each(assigns)("PUT assignee: %s", async (_label, site, key, body, status, after) => {
    const f = await fake(site);
    const v = site.startsWith("dc") ? 2 : 3;
    expect((await put(f, `/rest/api/${v}/issue/${key}/assignee`, body)).status).toBe(status);
    expect(issueOf(f, key).assignee).toBe(after);
  });

  test("PUT assignee: an inactive user cannot be assigned; a change is recorded and stamps updated", async () => {
    const f = await fake("cloud-scrum-company");
    f.site.users.find((u) => u.accountId === JANE)!.active = false;
    expect(await put(f, "/rest/api/3/issue/PAY-318/assignee", { accountId: JANE })).toMatchObject({ status: 400, body: { errors: { assignee: "User 'Jane Doe' cannot be assigned issues." } } });
    await put(f, "/rest/api/3/issue/PAY-318/assignee", { accountId: ME });
    const i = issueOf(f, "PAY-318");
    expect([i.updated, i.changelog.at(-1)!.items[0]]).toEqual(["2026-10-24T08:00:00.000+0000", { field: "assignee", fieldId: "assignee", from: null, fromString: null, to: ME, toString: "Ujjwal Solanki" }]);
  });

  test("POST comment: ADF on v3, wiki on v2; a string body on v3 is 400; the per-issue cap is 413", async () => {
    const f = await fake("cloud-scrum-company", { limits: { comments: 3 } });
    const adf = { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Picked up in hive." }] }] };
    const r = await post(f, "/rest/api/3/issue/PAY-318/comment", { body: adf });
    expect([r.status, r.body.body, r.body.author.accountId, issueOf(f, "PAY-318").updated]).toEqual([201, adf, ME, "2026-10-24T08:00:00.000+0000"]);
    expect(await post(f, "/rest/api/3/issue/PAY-318/comment", { body: "plain" })).toMatchObject({ status: 400, body: { errors: { comment: expect.stringContaining("Atlassian Document") } } });
    expect((await post(f, "/rest/api/3/issue/PAY-318/comment", { body: adf })).status).toBe(413);
    const v2 = await post(f, "/rest/api/2/issue/PAY-322/comment", { body: "From *v2*" });
    expect([v2.status, v2.body.body]).toEqual([201, "From *v2*"]);
    expect((await get(f, "/rest/api/3/issue/PAY-322/comment")).body.comments[0].body.type).toBe("doc");
    const dc = await fake("dc-v2-wiki");
    const w = await post(dc, "/rest/api/2/issue/CORE-1/comment", { body: "h3. Done\n* (/) shipped" });
    expect([w.status, w.body.body, issueOf(dc, "CORE-1").comments.at(-1)!.body]).toEqual([201, "h3. Done\n* (/) shipped", { wiki: "h3. Done\n* (/) shipped" }]);
  });

  test("PUT comment: only the author edits, the body stays ADF on v3, and the edit stamps both updated times", async () => {
    const f = await fake("cloud-scrum-company");
    const adf = (text: string) => ({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
    expect(await put(f, "/rest/api/3/issue/PAY-318/comment/10023", { body: adf("x") })).toMatchObject({ status: 403 });
    clock = NOW - 60_000;
    const mine = (await post(f, "/rest/api/3/issue/PAY-318/comment", { body: adf("first") })).body;
    clock = NOW;
    expect(await put(f, `/rest/api/3/issue/PAY-318/comment/${mine.id}`, { body: "plain" })).toMatchObject({ status: 400 });
    const r = await put(f, `/rest/api/3/issue/PAY-318/comment/${mine.id}`, { body: adf("second") });
    expect([r.status, r.body.body, r.body.created, r.body.updated, issueOf(f, "PAY-318").updated]).toEqual([200, adf("second"), "2026-10-24T07:59:00.000+0000", "2026-10-24T08:00:00.000+0000", "2026-10-24T08:00:00.000+0000"]);
    expect((await put(f, "/rest/api/3/issue/PAY-318/comment/1", { body: adf("x") })).status).toBe(404);
  });

  test("PUT issue: summary, labels, description and assignee, each change recorded; other fields and bad values are 400 with nothing applied", async () => {
    const f = await fake("cloud-scrum-company");
    const before = structuredClone(issueOf(f, "PAY-318"));
    const refused = await put(f, "/rest/api/3/issue/PAY-318", { fields: { summary: "New", priority: { name: "Low" }, labels: ["has space"] } });
    expect(refused).toMatchObject({ status: 400, body: { errors: { priority: expect.stringContaining("cannot be set"), labels: "Labels must be strings without spaces." } } });
    expect(issueOf(f, "PAY-318")).toEqual(before);
    const desc = { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "d" }] }] };
    expect((await put(f, "/rest/api/3/issue/PAY-318", { fields: { summary: "New", labels: ["x", "x", "y"], description: desc, assignee: { accountId: ME } } })).status).toBe(204);
    const i = issueOf(f, "PAY-318");
    expect([i.summary, i.labels, i.description, i.assignee, i.updated]).toEqual(["New", ["x", "y"], { adf: desc }, ME, "2026-10-24T08:00:00.000+0000"]);
    expect(i.changelog.slice(-2).flatMap((h) => h.items.map((x) => x.field))).toEqual(["assignee", "summary", "labels", "description"]);
    const noEdit = await fake("cloud-jwm-noboard");
    noEdit.site.permissions.MKT = noEdit.site.permissions.MKT!.filter((p) => p !== "EDIT_ISSUES");
    expect((await put(noEdit, "/rest/api/3/issue/MKT-1", { fields: { summary: "x" } })).status).toBe(403);
  });

  test("remote links: upsert by globalId nulls omitted fields, 413 past the cap, delete by globalId", async () => {
    const f = await fake("cloud-scrum-company", { limits: { remoteLinks: 2 } });
    const gid = "github-pr:acme/payments#1201";
    const full = { globalId: gid, relationship: "pull request", application: { type: "com.github", name: "GitHub" }, object: { url: "https://github.com/acme/payments/pull/1201", title: "PAY-318: retries", status: { resolved: false } } };
    const created = await post(f, "/rest/api/3/issue/PAY-318/remotelink", full);
    expect(created.status).toBe(201);
    const updated = await post(f, "/rest/api/3/issue/PAY-318/remotelink", { globalId: gid, object: { url: full.object.url, title: "PAY-318: retries (merged)" } });
    expect([updated.status, updated.body.id]).toEqual([200, created.body.id]);
    const link = (await get(f, `/rest/api/3/issue/PAY-318/remotelink?globalId=${encodeURIComponent(gid)}`)).body;
    expect(link).toEqual({ id: created.body.id, self: expect.any(String), globalId: gid, object: { url: full.object.url, title: "PAY-318: retries (merged)" } });
    await post(f, "/rest/api/3/issue/PAY-318/remotelink", { globalId: "other:1", object: { url: "https://example.com/1", title: "one" } });
    expect((await post(f, "/rest/api/3/issue/PAY-318/remotelink", { globalId: "other:2", object: { url: "https://example.com/2", title: "two" } })).status).toBe(413);
    expect((await post(f, "/rest/api/3/issue/PAY-318/remotelink", { globalId: gid, object: { url: full.object.url, title: "again" } })).status).toBe(200);
    expect(await post(f, "/rest/api/3/issue/PAY-318/remotelink", { object: { url: "https://example.com" } })).toMatchObject({ status: 400, body: { errors: { title: "'title' is required." } } });
    expect((await call(f, "DELETE", `/rest/api/3/issue/PAY-318/remotelink?globalId=${encodeURIComponent(gid)}`)).status).toBe(204);
    expect((await get(f, `/rest/api/3/issue/PAY-318/remotelink?globalId=${encodeURIComponent(gid)}`)).status).toBe(404);
    expect((await post(await fake("cloud-jwm-noboard"), "/rest/api/3/issue/MKT-1/remotelink", full)).status).toBe(403);
  });

  test("issue properties: 201 then 200, 32768 characters at most, EDIT_ISSUES, visible to search", async () => {
    const f = await fake("cloud-scrum-company");
    const value = { hiveVersion: "2026.10.6", branch: "PAY-322-metrics", by: "machine:1" };
    expect((await put(f, "/rest/api/3/issue/PAY-322/properties/hivemind", value)).status).toBe(201);
    expect((await put(f, "/rest/api/3/issue/PAY-322/properties/hivemind", value)).status).toBe(200);
    expect((await get(f, "/rest/api/3/issue/PAY-322/properties/hivemind")).body).toEqual({ key: "hivemind", value });
    expect((await search(f, "key = PAY-322", { properties: ["hivemind"] })).body.issues[0].properties.hivemind).toEqual(value);
    const big = JSON.stringify({ pad: "x".repeat(32760) });
    expect((await call(f, "PUT", "/rest/api/3/issue/PAY-322/properties/hivemind", { raw: big })).status).toBe(400);
    expect((await call(f, "PUT", "/rest/api/3/issue/PAY-322/properties/hivemind", { raw: JSON.stringify({ pad: "x".repeat(32750) }) })).status).toBe(200);
    expect((await put(await fake("cloud-jwm-noboard"), "/rest/api/3/issue/MKT-1/properties/hivemind", value)).status).toBe(403);
  });

  test.each([[false, "2026-10-23T07:30:00.000+0000"], [true, "2026-10-24T08:00:00.000+0000"]] as const)("a property write bumps updated only when propertyBumpsUpdated is %p", async (bumps, after) => {
    const f = await fake("cloud-scrum-company", { propertyBumpsUpdated: bumps });
    await put(f, "/rest/api/3/issue/PAY-322/properties/hivemind", { by: "machine:1" });
    expect(issueOf(f, "PAY-322").updated).toBe(after);
  });
});

describe("rate limits and faults", () => {
  test("a site fault fires on the Nth matching request with its headers, then the endpoint answers again", async () => {
    const f = await fake("cloud-scrum-company", {}, true);
    const statuses: number[] = [];
    let limited: Res | undefined;
    for (let n = 0; n < 4; n++) {
      const r = await search(f, "project = PAY");
      statuses.push(r.status);
      if (r.status === 429) limited = r;
    }
    expect(statuses).toEqual([200, 200, 429, 200]);
    expect(["Retry-After", "RateLimit-Reason", "X-RateLimit-Remaining"].map((h) => limited!.headers.get(h))).toEqual(["2", "jira-burst-based", "0"]);
  });

  test("a 2xx fault only adds its headers (near-limit warning)", async () => {
    const f = await fake("cloud-scrum-company", {}, true);
    const near = [];
    for (let n = 0; n < 3; n++) { const r = await get(f, "/rest/api/3/myself"); near.push([r.status, r.headers.get("X-RateLimit-NearLimit"), r.body.accountId]); }
    expect(near).toEqual([[200, null, ME], [200, "true", ME], [200, null, ME]]);
  });

  test("the site's per-issue and quota faults", async () => {
    const f = await fake("cloud-scrum-company", {}, true);
    await post(f, "/rest/api/3/issue/PAY-322/transitions", { transition: { id: "21" } });
    const second = await post(f, "/rest/api/3/issue/PAY-322/transitions", { transition: { id: "41" } });
    expect([second.status, second.headers.get("RateLimit-Reason"), issueOf(f, "PAY-322").status]).toEqual([429, "jira-per-issue-on-write", "3"]);
    const ops = await fake("cloud-kanban-team", {}, true);
    const out: (string | null)[] = [];
    for (let n = 0; n < 5; n++) out.push((await search(ops, "project = OPS")).headers.get("RateLimit-Reason"));
    expect(out).toEqual([null, null, null, null, "jira-quota-tenant-based"]);
  });

  test("perIssueWriteLimit: 20 writes per 2 s and 100 per 30 s per issue", async () => {
    const f = await fake("cloud-jwm-noboard", { perIssueWriteLimit: true });
    const adf = { type: "doc", version: 1, content: [] };
    const comment = (key: string) => post(f, `/rest/api/3/issue/${key}/comment`, { body: adf });
    for (let n = 0; n < 20; n++) expect((await comment("MKT-1")).status).toBe(201);
    const over = await comment("MKT-1");
    expect([over.status, over.headers.get("RateLimit-Reason"), over.headers.get("Retry-After")]).toEqual([429, "jira-per-issue-on-write", "2"]);
    expect((await comment("MKT-2")).status).toBe(201);
    clock += 2_000;
    expect((await comment("MKT-1")).status).toBe(201);
    for (let round = 0; round < 4; round++) {
      clock += 2_000;
      for (let n = 0; n < (round === 3 ? 19 : 20); n++) await comment("MKT-1");
    }
    clock += 2_000;
    expect((await comment("MKT-1")).status).toBe(429);
  });
});

describe("every fixture site answers the sync's first calls", () => {
  test.each([...SITES.keys()])("%s", async (name) => {
    const f = await fake(name);
    const v = f.site.deployment === "Cloud" ? 3 : 2;
    expect((await get(f, `/rest/api/${v}/myself`)).status).toBe(200);
    expect((await get(f, "/rest/api/2/serverInfo")).status).toBe(200);
    for (const p of f.site.projects) {
      expect((await get(f, `/rest/api/${v}/project/${p.key}/statuses`)).status).toBe(200);
      const jql = `project = ${p.key} ORDER BY key`;
      const r = v === 3 ? await search(f, jql, { fields: ["key"], maxResults: 100 }) : await get(f, `/rest/api/2/search?jql=${encodeURIComponent(jql)}`);
      expect(keys(r)).toEqual(f.site.issues.filter((i) => i.project === p.key && !i.restricted && !i.deleted).map((i) => i.key).sort((a, b) => Number(a.split("-")[1]) - Number(b.split("-")[1])));
    }
    for (const i of f.site.issues.filter((i) => !i.restricted && !i.deleted)) expect((await get(f, `/rest/api/${v}/issue/${i.key}/transitions`)).status).toBe(200);
    for (const b of f.site.boards) expect((await get(f, `/rest/agile/1.0/board/${b.id}/configuration`)).status).toBe(200);
  });
});

// ── OpenAPI schema check ──────────────────────────────────────────────────────────────────────
// Representative responses validate against Atlassian's response schemas (extracted with
// scripts/extract-schemas.ts into fixtures/openapi-schemas.json), with a validator for the subset
// of JSON Schema those use. `additionalProperties: false` is what catches a field Jira never sends.

type Schema = { $ref?: string; type?: string; properties?: Record<string, Schema>; additionalProperties?: boolean | Schema; required?: string[]; items?: Schema; enum?: unknown[]; allOf?: Schema[]; oneOf?: Schema[]; anyOf?: Schema[]; nullable?: boolean; maxItems?: number; minItems?: number };
type Root = { components: { schemas: Record<string, Schema> }; roots: Record<string, Schema> };
const SCHEMAS = JSON.parse(readFileSync(join(FIXTURES_DIR, "openapi-schemas.json"), "utf8")) as { v3: Root; agile: Root };

function validate(root: Root, s: Schema, v: unknown, at = "$"): string[] {
  if (s.$ref) return validate(root, root.components.schemas[s.$ref.split("/").at(-1)!]!, v, at);
  const errs: string[] = [];
  for (const sub of s.allOf ?? []) errs.push(...validate(root, sub, v, at));
  const alts = s.oneOf ?? s.anyOf;
  if (alts && !alts.some((a) => validate(root, a, v, at).length === 0)) errs.push(`${at}: matches none of the alternatives`);
  if (v === null) return s.type && !s.nullable ? [...errs, `${at}: null`] : errs;
  if (s.enum && !s.enum.includes(v)) errs.push(`${at}: ${JSON.stringify(v)} not in ${JSON.stringify(s.enum)}`);
  switch (s.type) {
    case "object": {
      if (typeof v !== "object" || Array.isArray(v)) return [...errs, `${at}: not an object`];
      const o = v as Record<string, unknown>;
      for (const r of s.required ?? []) if (!(r in o)) errs.push(`${at}.${r}: required`);
      for (const [k, x] of Object.entries(o)) {
        const p = s.properties?.[k];
        if (p) errs.push(...validate(root, p, x, `${at}.${k}`));
        else if (s.additionalProperties === false) errs.push(`${at}.${k}: not in the schema`);
        else if (typeof s.additionalProperties === "object") errs.push(...validate(root, s.additionalProperties, x, `${at}.${k}`));
      }
      return errs;
    }
    case "array":
      if (!Array.isArray(v)) return [...errs, `${at}: not an array`];
      if (s.maxItems !== undefined && v.length > s.maxItems) errs.push(`${at}: more than ${s.maxItems} items`);
      return [...errs, ...v.flatMap((x, n) => (s.items ? validate(root, s.items, x, `${at}[${n}]`) : []))];
    case "string": return typeof v === "string" ? errs : [...errs, `${at}: not a string`];
    case "integer": return Number.isInteger(v) ? errs : [...errs, `${at}: not an integer`];
    case "number": return typeof v === "number" ? errs : [...errs, `${at}: not a number`];
    case "boolean": return typeof v === "boolean" ? errs : [...errs, `${at}: not a boolean`];
  }
  return errs;
}

describe("responses match Atlassian's OpenAPI response schemas", () => {
  test("the validator rejects what the schemas forbid", () => {
    const { v3 } = SCHEMAS;
    expect(validate(v3, v3.roots.myself!, { accountId: "x", displayName: "y" })).toEqual([]);
    expect(validate(v3, v3.roots.myself!, { accountId: 1, nickname: "z" })).toEqual(["$.accountId: not a string", "$.nickname: not in the schema"]);
    expect(validate(v3, v3.roots["project/statuses"]!, [{ id: "1" }])).toContain("$[0].statuses: required");
  });

  const cloud = [...SITES.values()].filter((s) => s.deployment === "Cloud").map((s) => s.name);
  test.each(cloud)("%s", async (name) => {
    const f = await fake(name);
    const { v3, agile } = SCHEMAS;
    const problems: string[] = [];
    const check = (root: Root, schema: Schema, label: string, body: unknown) => problems.push(...validate(root, schema, body).map((e) => `${label} ${e}`));
    const site: Site = f.site;
    const project = site.projects[0]!.key;
    check(v3, v3.roots.myself!, "myself", (await get(f, "/rest/api/3/myself")).body);
    const s = await search(f, `project = ${project} ORDER BY key`, { fields: ["*all"], expand: "changelog", maxResults: 2 });
    check(v3, v3.roots["search/jql"]!, "search/jql", s.body);
    for (const i of s.body.issues) {
      check(v3, v3.roots.StatusDetails!, `${i.key}.status`, i.fields.status);
      check(v3, v3.roots.IssueTypeDetails!, `${i.key}.issuetype`, i.fields.issuetype);
      if (i.fields.assignee) check(v3, v3.roots.UserDetails!, `${i.key}.assignee`, i.fields.assignee);
    }
    check(v3, v3.roots["issue/bulkfetch"]!, "bulkfetch", (await post(f, "/rest/api/3/issue/bulkfetch", { issueIdsOrKeys: site.issues.map((i) => i.key), fields: ["summary", "status"] })).body);
    for (const i of site.issues.filter((i) => !i.restricted && !i.deleted)) {
      check(v3, v3.roots.transitions!, `${i.key} transitions`, (await get(f, `/rest/api/3/issue/${i.key}/transitions?expand=transitions.fields&includeUnavailableTransitions=true`)).body);
    }
    for (const p of site.projects) check(v3, v3.roots["project/statuses"]!, `${p.key} statuses`, (await get(f, `/rest/api/3/project/${p.key}/statuses`)).body);
    check(agile, agile.roots.board!, "board list", (await get(f, `/rest/agile/1.0/board?projectKeyOrId=${project}`)).body);
    for (const b of site.boards) {
      check(agile, agile.roots["board/configuration"]!, `board ${b.id} configuration`, (await get(f, `/rest/agile/1.0/board/${b.id}/configuration`)).body);
      if (b.type !== "scrum") continue;
      // The spec gives the sprint list no response schema; its values are SprintBeans.
      const sprints = (await get(f, `/rest/agile/1.0/board/${b.id}/sprint`)).body;
      check(agile, { type: "object", additionalProperties: false, properties: { maxResults: { type: "integer" }, startAt: { type: "integer" }, total: { type: "integer" }, isLast: { type: "boolean" }, values: { type: "array", items: agile.roots.SprintBean! } } }, `board ${b.id} sprints`, sprints);
    }
    expect(problems).toEqual([]);
  });
});
