import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { loadSites } from "./index.js";
import { createFakeRovoMcp, type FakeRovoMcp, type FakeRovoMcpOptions } from "./mcp-server.js";

// The fake Rovo MCP server is the only Rovo the Jira plugin's MCP transport meets before a live
// site (design §9.2, §15), so each block holds one behaviour that transport depends on, driven
// the way the plugin will drive it: the real SDK Client, StreamableHTTPClientTransport and an
// OAuthClientProvider doing DCR + PKCE + a loopback redirect. Raw fetch only where the SDK hides
// what the test needs (status codes, headers, a token request the SDK would never send).

const SITES = loadSites();
const CLOUD = ["cloud-scrum-company", "cloud-kanban-team", "cloud-jwm-noboard"];
const NOW = Date.parse("2026-10-24T08:00:00.000Z");
const ME = "5b10ac8d82e05b22cc7d4ef5";
const JANE = "5b10a2844c20165700ede21g";
/** Every tool the sync calls (design §9.2), as it calls them with `?tools=all`. */
const SYNC_TOOLS = [
  "getAccessibleAtlassianResources", "atlassianUserInfo", "getJiraCurrentUser", "searchJiraIssuesUsingJql", "getJiraIssue",
  "listJiraStatuses", "listJiraIssueTransitions", "transitionJiraIssue", "listJiraIssueComments", "addOrEditJiraIssueComment",
  "listJiraIssueChangelogs", "listJiraBoards", "getJiraBoardConfig", "listJiraBoardSprints", "getJiraBoardIssueData", "getJiraBoardSprintData",
  "getJiraIssueTypeMetaWithFields", "listJiraProjectIssueTypesMetadata", "listJiraIssueAssignableUsers", "lookupJiraAccountId",
  "editJiraIssue", "createJiraIssueRemoteIssueLink", "listJiraIssueRemoteIssueLinks", "getJiraEntityProperty", "editJiraEntityProperty",
];

let clock = NOW;
let open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).reverse().map((o) => o.close()));
  clock = NOW;
});

async function fake(name: string, opts: FakeRovoMcpOptions = {}): Promise<FakeRovoMcp> {
  const site = SITES.get(name)!;
  const f = await createFakeRovoMcp({ ...site, faults: [] }, { now: () => new Date(clock), ...opts });
  open.push(f);
  return f;
}

/**
 * The plugin's sign-in, in test form: stores what the SDK hands it, and "opens the browser" by
 * fetching the authorize URL, which follows the redirect to a loopback listener that keeps the code.
 */
class LoopbackProvider implements OAuthClientProvider {
  info?: OAuthClientInformationMixed;
  saved?: OAuthTokens;
  verifier = "";
  authorizeUrls: URL[] = [];
  codes: string[] = [];
  errors: string[] = [];
  invalidated: string[] = [];
  private constructor(private server: Server, readonly redirectUrl: string, readonly name: string) {}
  static async start(name = "hivemind"): Promise<LoopbackProvider> {
    let self: LoopbackProvider | undefined;
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      const code = u.searchParams.get("code"), error = u.searchParams.get("error");
      if (code) self!.codes.push(code);
      if (error) self!.errors.push(error);
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("You can close this window.");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    self = new LoopbackProvider(server, `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`, name);
    open.push(self);
    return self;
  }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: this.name, redirect_uris: [this.redirectUrl], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  }
  clientInformation() { return this.info; }
  saveClientInformation(i: OAuthClientInformationMixed) { this.info = i; }
  tokens() { return this.saved; }
  saveTokens(t: OAuthTokens) { this.saved = t; }
  async redirectToAuthorization(url: URL) { this.authorizeUrls.push(url); await fetch(url); }
  saveCodeVerifier(v: string) { this.verifier = v; }
  codeVerifier() { return this.verifier; }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    this.invalidated.push(scope);
    if (scope === "all" || scope === "client") this.info = undefined;
    if (scope === "all" || scope === "tokens") this.saved = undefined;
  }
  close() { return new Promise<void>((r) => { this.server.close(() => r()); this.server.closeAllConnections(); }); }
}

function client(f: FakeRovoMcp, init: { provider?: LoopbackProvider; headers?: Record<string, string>; flat?: boolean; name?: string }) {
  const c = new Client({ name: init.name ?? init.provider?.name ?? "hivemind", version: "1.0.0" });
  const t = new StreamableHTTPClientTransport(new URL(init.flat === false ? f.url : `${f.url}?tools=all`), {
    authProvider: init.provider,
    ...(init.headers ? { requestInit: { headers: init.headers } } : {}),
  });
  return { c, t };
}

/** Connects; on a first sign-in, finishes the browser round-trip and connects again. */
async function connect(f: FakeRovoMcp, p: LoopbackProvider, o: { flat?: boolean; name?: string } = {}): Promise<Client> {
  const streamsBefore = f.requests.filter((r) => r.method === "GET" && r.path === "/v2/mcp" && r.status === 405).length;
  let { c, t } = client(f, { provider: p, ...o });
  try {
    await c.connect(t);
  } catch (e) {
    if (!(e instanceof UnauthorizedError) || !p.codes.length) throw e;
    await t.finishAuth(p.codes.at(-1)!);
    ({ c, t } = client(f, { provider: p, ...o }));
    await c.connect(t);
  }
  open.push({ close: () => c.close() });
  // The transport opens its GET stream unawaited after connecting; wait for its answer (405) so a
  // later 401 doesn't race it into a second refresh (see the refresh-reuse test).
  const gets = () => f.requests.filter((r) => r.method === "GET" && r.path === "/v2/mcp" && r.status === 405).length;
  for (let n = 0; n < 100 && gets() < 1 + streamsBefore; n++) await new Promise((r) => setTimeout(r, 5));
  return c;
}

async function signedIn(name: string, opts: FakeRovoMcpOptions = {}, clientName?: string) {
  const f = await fake(name, opts);
  const p = await LoopbackProvider.start(clientName);
  const c = await connect(f, p);
  return { f, p, c };
}

type Out = { data: any; structured: any; isError: boolean; error?: { message: string; statusCode: number }; text: string };
async function call(c: Client, f: FakeRovoMcp, name: string, args: Record<string, unknown> = {}): Promise<Out> {
  const r = await c.callTool({ name, arguments: { cloudId: f.site.cloudId, ...args } });
  const text = (r.content as { text: string }[])[0]!.text;
  const parsed = JSON.parse(text.split("\n")[0]!);
  return { data: parsed.data ?? parsed, structured: r.structuredContent, isError: !!r.isError, error: parsed.error ? parsed : undefined, text };
}

/** The same Jira over REST (the gateway, where Rovo's `self` links point), for "MCP and REST see one Jira". */
async function rest(f: FakeRovoMcp, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${f.jira.gatewayUrl}${path}`, { method, headers: { Authorization: f.jira.authorization("scoped"), "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return res.status === 204 ? undefined : res.json();
}

/** A raw JSON-RPC POST to the MCP endpoint. */
async function rpc(f: FakeRovoMcp, auth: string, body: unknown, session?: string): Promise<{ status: number; headers: Headers; json: any }> {
  const res = await fetch(`${f.url}?tools=all`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(session ? { "Mcp-Session-Id": session } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : undefined };
}
const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } } };
async function rawSession(f: FakeRovoMcp, auth: string): Promise<string> {
  const r = await rpc(f, auth, initialize);
  expect(r.status).toBe(200);
  return r.headers.get("mcp-session-id")!;
}
const toolCall = (id: number, name: string, args: Record<string, unknown>) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

/** Registration, authorization and a code, by hand, for the token-endpoint refusals. */
async function codeByHand(f: FakeRovoMcp, redirect = "http://127.0.0.1:9/cb", challenge?: string) {
  const verifier = randomBytes(32).toString("base64url");
  const reg = await (await fetch(`${f.origin}/fake-rovo-issuer/dcr/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirect], client_name: "raw", scope: "offline_access read:jira:agent-interface" }) })).json() as { client_id: string };
  const u = new URL(`${f.origin}/authorize`);
  for (const [k, v] of Object.entries({ response_type: "code", client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge ?? createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", scope: "offline_access read:jira:agent-interface" })) u.searchParams.set(k, v);
  const res = await fetch(u, { redirect: "manual" });
  const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
  return { client_id: reg.client_id, verifier, code, redirect };
}
async function token(f: FakeRovoMcp, form: Record<string, string>): Promise<{ status: number; json: any }> {
  const res = await fetch(`${f.origin}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) });
  return { status: res.status, json: await res.json() };
}

describe("sign in with Atlassian: OAuth 2.1, DCR, PKCE S256, loopback redirect", () => {
  test("the first connect discovers the auth server, registers, consents through the loopback and gets rotating tokens", async () => {
    const { f, p, c } = await signedIn("cloud-scrum-company");
    expect(f.oauth.log.map((l) => `${l.endpoint}${l.grant ? `:${l.grant}` : ""} ${l.status}`)).toEqual(["register 201", "authorize 302", "token:authorization_code 200"]);
    const asked = p.authorizeUrls[0]!;
    expect(asked.searchParams.get("code_challenge_method")).toBe("S256");
    expect(asked.searchParams.get("redirect_uri")).toBe(p.redirectUrl);
    expect(asked.searchParams.get("resource")).toBe(f.url);
    expect(asked.searchParams.get("scope")).toContain("offline_access");
    expect(p.saved).toMatchObject({ token_type: "Bearer", expires_in: 28800 });
    expect(p.saved!.refresh_token).toBeString();
    // Metadata lives only at the path-qualified URLs, as on mcp.atlassian.com.
    const http = f.requests.filter((r) => r.kind === "http").map((r) => `${r.method} ${r.path} ${r.status}`);
    expect(http).toContain("GET /.well-known/oauth-protected-resource/v2/mcp 200");
    expect(http).toContain("GET /.well-known/oauth-authorization-server/fake-rovo-issuer 200");
    expect((await fetch(`${f.origin}/.well-known/oauth-protected-resource`)).status).toBe(404);
    expect((await call(c, f, "getJiraCurrentUser")).data.accountId).toBe(ME);
    expect(f.requests.filter((r) => r.kind === "tool").map((r) => r.auth)).toEqual(["oauth"]);
  });

  test("the token endpoint refuses a wrong verifier, a reused code and a different redirect_uri", async () => {
    const f = await fake("cloud-scrum-company");
    const rows: [string, (g: Awaited<ReturnType<typeof codeByHand>>) => Promise<{ status: number; json: any }>, string][] = [
      ["wrong verifier", (g) => token(f, { grant_type: "authorization_code", client_id: g.client_id, code: g.code, redirect_uri: g.redirect, code_verifier: "x".repeat(43) }), "invalid_grant"],
      ["reused code", async (g) => {
        const form = { grant_type: "authorization_code", client_id: g.client_id, code: g.code, redirect_uri: g.redirect, code_verifier: g.verifier };
        expect((await token(f, form)).status).toBe(200);
        return token(f, form);
      }, "invalid_grant"],
      ["other redirect_uri", (g) => token(f, { grant_type: "authorization_code", client_id: g.client_id, code: g.code, redirect_uri: "http://127.0.0.1:9/other", code_verifier: g.verifier }), "invalid_grant"],
      ["unknown client", (g) => token(f, { grant_type: "authorization_code", client_id: "nobody", code: g.code, redirect_uri: g.redirect, code_verifier: g.verifier }), "invalid_client"],
    ];
    for (const [name, send, error] of rows) {
      const r = await send(await codeByHand(f));
      expect({ name, status: r.status, error: r.json.error }).toEqual({ name, status: error === "invalid_client" ? 401 : 400, error });
    }
  });

  test("authorize and registration refuse what Atlassian refuses", async () => {
    const redirectError = async (f: FakeRovoMcp, params: Record<string, string>) => {
      const reg = await (await fetch(`${f.origin}/fake-rovo-issuer/dcr/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:9/cb"] }) })).json() as { client_id: string };
      const u = new URL(`${f.origin}/authorize`);
      for (const [k, v] of Object.entries({ response_type: "code", client_id: reg.client_id, redirect_uri: "http://127.0.0.1:9/cb", code_challenge: "abc", code_challenge_method: "S256", state: "s1", ...params })) u.searchParams.set(k, v);
      const res = await fetch(u, { redirect: "manual" });
      const back = new URL(res.headers.get("location")!);
      return { error: back.searchParams.get("error"), state: back.searchParams.get("state") };
    };
    const register = async (f: FakeRovoMcp, uri: string) => {
      const res = await fetch(`${f.origin}/fake-rovo-issuer/dcr/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: [uri] }) });
      return res.status === 201 ? "registered" : ((await res.json()) as { error: string }).error;
    };
    const f = await fake("cloud-scrum-company");
    expect(await redirectError(f, { code_challenge_method: "plain" })).toEqual({ error: "invalid_request", state: "s1" });
    expect(await redirectError(f, { code_challenge: "" })).toEqual({ error: "invalid_request", state: "s1" });
    expect(await redirectError(f, { resource: "https://elsewhere.example/mcp" })).toEqual({ error: "invalid_target", state: "s1" });
    expect(await register(f, "http://127.0.0.1:5555/cb")).toBe("registered");
    expect(await register(f, "http://localhost:5555/cb")).toBe("registered");
    expect(await register(f, "https://app.example/cb")).toBe("invalid_redirect_uri");
    const allow = await fake("cloud-scrum-company", { allowedRedirects: ["https://app.example/"] });
    expect(await register(allow, "https://app.example/cb")).toBe("registered");
    const noLoopback = await fake("cloud-scrum-company", { allowLoopback: false });
    expect(await register(noLoopback, "http://127.0.0.1:5555/cb")).toBe("invalid_redirect_uri");
    const declined = await fake("cloud-scrum-company", { consent: false });
    expect((await redirectError(declined, {})).error).toBe("access_denied");
    // Through the SDK, a refused loopback is a sign-in that fails, not a hang.
    const p = await LoopbackProvider.start();
    await expect(connect(noLoopback, p)).rejects.toThrow(/redirect/i);
  });

  test("an expired access token is refreshed once, and the refresh token rotates", async () => {
    const { f, p, c } = await signedIn("cloud-scrum-company", { accessTtlS: 60 });
    const first = p.saved!.refresh_token!;
    clock += 61_000;
    expect((await call(c, f, "getJiraCurrentUser")).data.accountId).toBe(ME);
    expect(f.oauth.log.filter((l) => l.grant === "refresh_token").map((l) => l.status)).toEqual([200]);
    expect(p.saved!.refresh_token).not.toBe(first);
  });

  test("a rotated-out refresh token works within the grace window; reused later, it revokes the whole grant", async () => {
    const f = await fake("cloud-scrum-company", { refreshGraceS: 10 });
    const g = await codeByHand(f);
    const tokens = (await token(f, { grant_type: "authorization_code", client_id: g.client_id, code: g.code, redirect_uri: g.redirect, code_verifier: g.verifier })).json;
    const refreshWith = (rt: string) => token(f, { grant_type: "refresh_token", client_id: g.client_id, refresh_token: rt });
    const second = (await refreshWith(tokens.refresh_token)).json.refresh_token as string;
    clock += 5_000;
    expect((await refreshWith(tokens.refresh_token)).status).toBe(200);
    clock += 6_000;
    expect((await refreshWith(tokens.refresh_token)).json).toEqual({ error: "invalid_grant", error_description: "Refresh token reuse detected; the grant has been revoked." });
    expect((await refreshWith(second)).json.error).toBe("invalid_grant");
  });

  test("a refresh token idle past refreshIdleS fails with unauthorized_client (#260): the client re-registers and must sign in again", async () => {
    const { f, p, c } = await signedIn("cloud-scrum-company", { accessTtlS: 60, refreshIdleS: 3600 });
    clock += 2 * 3600_000;
    await expect(call(c, f, "getJiraCurrentUser")).rejects.toBeInstanceOf(UnauthorizedError);
    expect(f.oauth.log.find((l) => l.grant === "refresh_token")).toMatchObject({ status: 400, error: "unauthorized_client" });
    // The SDK treats unauthorized_client as "start over": forget the client and send the person back to consent.
    expect(p.invalidated).toEqual(["all"]);
    expect(f.oauth.log.slice(-2).map((l) => l.endpoint)).toEqual(["register", "authorize"]);
    expect(p.codes).toHaveLength(2);
  });

  test("forgotten clients (CHANGE-3170): a cached client_id gets invalid_client and the client registers again", async () => {
    for (const how of ["option", "method"] as const) {
      const { f, p, c } = await signedIn("cloud-scrum-company", how === "option" ? { forgetClients: true } : {});
      if (how === "method") f.oauth.forgetClients();
      f.oauth.expireAccessTokens();
      await expect(call(c, f, "getJiraCurrentUser")).rejects.toBeInstanceOf(UnauthorizedError);
      expect(f.oauth.log.find((l) => l.grant === "refresh_token")).toMatchObject({ status: 401, error: "invalid_client" });
      expect(f.oauth.log.filter((l) => l.endpoint === "register")).toHaveLength(2);
      expect(p.invalidated).toEqual(["all"]);
    }
  });

  test("a stale grant (#283): Jira tools answer 403 app not installed and the site comes back without scopes, until the grant is fresh", async () => {
    const { f, c } = await signedIn("cloud-scrum-company", { appNotInstalled: true });
    const res = await call(c, f, "getAccessibleAtlassianResources");
    expect(res.data).toEqual([expect.objectContaining({ id: f.site.cloudId })]);
    expect(res.data[0].scopes).toBeUndefined();
    const denied = await call(c, f, "searchJiraIssuesUsingJql", { jql: "project = PAY" });
    expect(denied.isError).toBe(true);
    expect(JSON.parse(denied.text)).toEqual({ code: 403, message: "The app is not installed on this instance" });
    f.oauth.setAppInstalled(true);
    expect((await call(c, f, "getAccessibleAtlassianResources")).data[0].scopes).toContain("read:jira:agent-interface");
    expect((await call(c, f, "searchJiraIssuesUsingJql", { jql: "project = PAY" })).isError).toBe(false);
  });
});

describe("API token (admin-enabled, scoped)", () => {
  test("only a scoped token with the three agent-interface scopes works, and only when an admin enabled it; cloudId is a tool argument", async () => {
    const off = await fake("cloud-scrum-company");
    const on = await fake("cloud-scrum-company", { apiTokens: true });
    const narrow = await fake("cloud-scrum-company", { apiTokens: true, apiTokenScopes: ["read:jira:agent-interface", "write:jira:agent-interface"] });
    const rows: [string, FakeRovoMcp, string, number][] = [
      ["not enabled", off, off.oauth.apiTokenAuthorization(), 401],
      ["classic token", on, on.oauth.apiTokenAuthorization("classic"), 401],
      ["missing search scope", narrow, narrow.oauth.apiTokenAuthorization(), 401],
      ["scoped token", on, on.oauth.apiTokenAuthorization(), 200],
    ];
    for (const [name, f, auth, status] of rows) expect({ name, status: (await rpc(f, auth, initialize)).status }).toEqual({ name, status });

    const { c, t } = client(on, { headers: { Authorization: on.oauth.apiTokenAuthorization() } });
    await c.connect(t);
    open.push({ close: () => c.close() });
    expect((await call(c, on, "getJiraCurrentUser")).data.accountId).toBe(ME);
    const missing = await c.callTool({ name: "getJiraCurrentUser", arguments: {} });
    expect(missing.isError).toBe(true);
    expect(JSON.parse((missing.content as { text: string }[])[0]!.text)).toEqual({ error: true, message: "Invalid input: cloudId is required", statusCode: 400 });
    // The site URL is a cloudId too; another site's is not.
    expect((await call(c, on, "getJiraCurrentUser", { cloudId: on.site.baseUrl })).isError).toBe(false);
    expect((await call(c, on, "getJiraCurrentUser", { cloudId: "00000000-0000-0000-0000-000000000000" })).error?.statusCode).toBe(404);
    expect(on.requests.filter((r) => r.kind === "tool").map((r) => r.auth)).toEqual(["apiToken", "apiToken", "apiToken", "apiToken"]);
  });
});

describe("tools/list", () => {
  test("?tools=all lists every tool flat, 50 to a page behind a cursor; plain /v2/mcp lists the primary tools and reaches the rest through execute", async () => {
    const { f, c, p } = await signedIn("cloud-scrum-company");
    const pages: string[][] = [];
    let cursor: string | undefined;
    do {
      const r = await c.listTools({ cursor });
      pages.push(r.tools.map((t) => t.name));
      cursor = r.nextCursor;
    } while (cursor);
    expect(pages.map((x) => x.length)).toEqual([50, 50, 50, 50, 15]);
    const all = pages.flat();
    expect(new Set(all).size).toBe(all.length);
    expect(SYNC_TOOLS.filter((t) => !all.includes(t))).toEqual([]);
    expect(all).toContain("search");
    expect(all).not.toContain("getJiraWorkflows");
    expect(all).not.toContain("findJiraIssueAssignableUsers");
    await expect(c.listTools({ cursor: "bm90LWEtY3Vyc29y" })).rejects.toThrow(/cursor/i);

    const plain = await connect(f, p, { flat: false });
    const primary = (await plain.listTools()).tools.map((t) => t.name);
    expect(primary).toHaveLength(21);
    expect(primary).toEqual(expect.arrayContaining(["getJiraIssue", "searchJiraIssuesUsingJql", "transitionJiraIssue", "discover", "executeRead", "executeWrite"]));
    expect(primary).not.toContain("listJiraIssueTransitions");
    await expect(plain.callTool({ name: "listJiraIssueTransitions", arguments: { cloudId: f.site.cloudId, issueIdOrKey: "PAY-318" } })).rejects.toThrow(/not found/);
    const found = await call(plain, f, "discover", { query: "issue transitions" });
    expect(found.data.results[0]).toMatchObject({ name: "listJiraIssueTransitions", executeTool: "executeRead" });
    const via = await call(plain, f, "executeRead", { name: "listJiraIssueTransitions", inputs: { issueIdOrKey: "PAY-318" } });
    expect(via.data.transitions.map((t: { id: string }) => t.id)).toEqual(["81"]);
    expect((await call(plain, f, "executeWrite", { name: "listJiraIssueTransitions", inputs: { issueIdOrKey: "PAY-318" } })).error?.message).toMatch(/executeRead/);
    expect((await call(plain, f, "executeRead", { name: "noSuchOperation" })).error?.message).toBe('Unknown operation "noSuchOperation". Use discover to find valid operation names.');
  });

  test("manage_jira, the pre-CHANGE-3452 names and a site's missing operations follow the options", async () => {
    const names = async (opts: FakeRovoMcpOptions) => {
      const { f, c } = await signedIn("cloud-scrum-company", opts);
      const out: string[] = [];
      let cursor: string | undefined;
      do { const r = await c.listTools({ cursor }); out.push(...r.tools.map((t) => t.name)); cursor = r.nextCursor; } while (cursor);
      return { f, c, out };
    };
    const manage = await names({ manageJira: true, jira: { admin: true } });
    expect(manage.out).toContain("getJiraWorkflows");
    const graph = await call(manage.c, manage.f, "getJiraWorkflows", { projectIdOrKey: "PAY" });
    expect(graph.data.workflows.map((w: { name: string }) => w.name).sort()).toEqual(Object.keys(manage.f.site.workflows).sort());
    const old = await names({ oldNames: true });
    expect(old.out).toContain("findJiraIssueAssignableUsers");
    expect((await call(old.c, old.f, "findJiraIssueAssignableUsers", { project: "PAY" })).data).toEqual((await call(old.c, old.f, "listJiraIssueAssignableUsers", { project: "PAY" })).data);
    const missing = await names({ unavailable: ["listJiraBoards"] });
    expect(missing.out).not.toContain("listJiraBoards");
    expect((await call(missing.c, missing.f, "executeRead", { name: "listJiraBoards" })).error?.message).toMatch(/^Unknown operation "listJiraBoards"/);
    expect(missing.out).toContain("listJiraBoardSprints");
  });
});

describe("the sync's tools on the Cloud sites: one Jira with the REST fake", () => {
  for (const name of CLOUD) {
    test(`${name}: identity, search pages, issues, statuses, transitions, comments, changelogs, boards and metadata agree with REST`, async () => {
      const { f, c } = await signedIn(name);
      const site = f.site;
      const project = site.projects[0]!;
      expect((await call(c, f, "getAccessibleAtlassianResources")).data[0].id).toBe(site.cloudId);
      expect((await call(c, f, "getJiraCurrentUser")).data.accountId).toBe(site.myself);
      expect((await call(c, f, "atlassianUserInfo")).data.account_id).toBe(site.myself);

      // Search: pages of 2 through nextPageToken, the same keys REST returns, and the structured envelope's cursor.
      const jql = `project = ${project.key} ORDER BY key ASC`;
      const want = (await rest(f, "POST", "/rest/api/3/search/jql", { jql, fields: ["summary"], maxResults: 100 })).issues.map((i: { key: string }) => i.key);
      const got: string[] = [];
      let next: string | undefined;
      do {
        const page = await call(c, f, "searchJiraIssuesUsingJql", { jql, maxResults: 2, fields: ["summary", "status", "labels"], ...(next ? { nextPageToken: next } : {}) });
        got.push(...page.data.issues.map((i: { key: string }) => i.key));
        for (const i of page.data.issues) expect(Object.keys(i.fields).sort()).toEqual(["labels", "status", "summary"]);
        expect(page.structured.issues.pageInfo).toEqual({ hasNextPage: !page.data.isLast, endCursor: page.data.nextPageToken ?? null });
        expect(page.structured.issues.nodes.map((n: { webUrl: string }) => n.webUrl)).toEqual(page.data.issues.map((i: { key: string }) => `${site.baseUrl}/browse/${i.key}`));
        next = page.data.nextPageToken;
      } while (next);
      expect(got).toEqual(want);
      const counted = await call(c, f, "searchJiraIssuesUsingJql", { jql, searchResultMode: "count" });
      expect(counted.data.total).toBe(want.length);

      // An issue: compact keeps the fixed key set; full returns what is asked, but never comments.
      const key = want[0]!;
      const compact = await call(c, f, "getJiraIssue", { issueIdOrKey: key, fields: ["summary", "labels", "issuetype", "status", "comment"] });
      expect(Object.keys(compact.data.fields).sort()).toEqual(["status", "summary"]);
      const full = await call(c, f, "getJiraIssue", { issueIdOrKey: key, view: "full", fields: ["labels", "issuetype", "comment"] });
      const restIssue = await rest(f, "GET", `/rest/api/3/issue/${key}?fields=labels,issuetype`);
      expect(full.data.fields).toEqual({ labels: restIssue.fields.labels, issuetype: restIssue.fields.issuetype });

      expect((await call(c, f, "listJiraProjects")).data).toEqual(await rest(f, "GET", "/rest/api/3/project/search"));
      const statuses = await call(c, f, "listJiraStatuses", { mode: "project", projectKey: project.key });
      expect(statuses.data).toEqual(await rest(f, "GET", `/rest/api/3/project/${project.key}/statuses`));
      const named = (await call(c, f, "listJiraStatuses", { mode: "search", statusCategory: "done" })).data.statuses.map((x: { id: string }) => x.id);
      expect(named).toEqual(site.statuses.filter((x) => x.statusCategory.key === "done").map((x) => x.id));
      const transitions = await call(c, f, "listJiraIssueTransitions", { issueIdOrKey: key, expand: "transitions.fields" });
      expect(transitions.data).toEqual(await rest(f, "GET", `/rest/api/3/issue/${key}/transitions?expand=transitions.fields`));
      const comments = await call(c, f, "listJiraIssueComments", { issueIdOrKey: key });
      const restComments = await rest(f, "GET", `/rest/api/3/issue/${key}/comment`);
      expect(comments.data.total).toBe(restComments.total);
      expect(comments.data.comments.map((x: { id: string; body: unknown }) => [x.id, typeof x.body])).toEqual(restComments.comments.map((x: { id: string }) => [x.id, "string"]));
      expect((await call(c, f, "listJiraIssueChangelogs", { issueIdOrKey: key })).data).toEqual(await rest(f, "GET", `/rest/api/3/issue/${key}/changelog`));

      // Boards: list, configuration, sprints, the active sprint's issues and the board's issues.
      const boards = (await call(c, f, "listJiraBoards", {})).data.values.map((b: { id: number }) => b.id);
      expect(boards).toEqual(site.boards.map((b) => b.id));
      for (const b of site.boards) {
        expect((await call(c, f, "getJiraBoardConfig", { boardId: b.id })).data).toEqual(await rest(f, "GET", `/rest/agile/1.0/board/${b.id}/configuration`));
        const boardJql = `${b.filter.jql.split(/\s+ORDER BY\s+/i)[0]}`;
        const viaBoard = (await call(c, f, "getJiraBoardIssueData", { boardId: b.id, maxResults: 100 })).data.issues.map((i: { key: string }) => i.key).sort();
        expect(viaBoard).toEqual((await rest(f, "POST", "/rest/api/3/search/jql", { jql: boardJql, fields: ["summary"], maxResults: 100 })).issues.map((i: { key: string }) => i.key).sort());
        const backlog = await call(c, f, "getJiraBoardIssueData", { boardId: b.id, dataset: "backlog", maxResults: 100 });
        const restBacklog = await rest(f, "GET", `/rest/software/1.0/board/${b.id}/backlog?maxResults=100`);
        if (restBacklog.issues) expect(backlog.data.issues.map((i: { key: string }) => i.key)).toEqual(restBacklog.issues.map((i: { key: string }) => i.key));
        else expect(backlog.error).toEqual({ error: true, message: restBacklog.errorMessages[0], statusCode: 400 });
        if (b.type !== "scrum") continue;
        expect((await call(c, f, "listJiraBoardSprints", { boardId: b.id })).data).toEqual(await rest(f, "GET", `/rest/agile/1.0/board/${b.id}/sprint`));
        const active = await call(c, f, "getJiraBoardSprintData", { boardId: String(b.id), includeIssues: true });
        expect(active.data.sprint.state).toBe("active");
        expect(active.data.issues.map((i: { key: string }) => i.key).sort()).toEqual((await rest(f, "POST", "/rest/api/3/search/jql", { jql: `sprint = ${active.data.sprint.id}`, fields: ["summary"], maxResults: 100 })).issues.map((i: { key: string }) => i.key).sort());
      }

      // Field and type metadata, assignable users and account lookup.
      const types = await call(c, f, "listJiraProjectIssueTypesMetadata", { projectIdOrKey: project.key });
      expect(types.data.issueTypes.map((t: { id: string }) => t.id)).toEqual(project.issueTypes.map((t) => t.id));
      const meta = await call(c, f, "getJiraIssueTypeMetaWithFields", { projectIdOrKey: project.key, issueTypeId: project.issueTypes[0]!.id, requiredFieldsOnly: true });
      expect(meta.data.fields.map((x: { fieldId: string }) => x.fieldId)).toEqual(expect.arrayContaining(["summary", "issuetype", "project"]));
      const assignable = (await call(c, f, "listJiraIssueAssignableUsers", { issueKey: key })).data.map((u: { accountId: string }) => u.accountId);
      expect(assignable).toEqual(site.users.filter((u) => u.active && (u.accountId !== site.myself || site.permissions[project.key]?.includes("ASSIGNABLE_USER"))).map((u) => u.accountId));
      const someone = site.users.find((u) => u.accountId !== site.myself)!;
      expect((await call(c, f, "lookupJiraAccountId", { query: someone.displayName })).data.map((u: { accountId: string }) => u.accountId)).toEqual([someone.accountId]);
    });
  }

  test("rich text comes back as markdown, or as HTML when markdown can't carry it; an ADF request is ignored (#189)", async () => {
    const { f, c } = await signedIn("cloud-kanban-team");
    const md = await call(c, f, "getJiraIssue", { issueIdOrKey: "OPS-1", responseContentFormat: "adf" });
    expect(md.data.appliedContentFormat).toBe("markdown");
    expect(md.data.fields.description).toBe("Certs expire on the 3rd.\n\n**Acceptance criteria**\n\n- New certs on every edge node\n- Old certs revoked");
    expect((await call(c, f, "getJiraIssue", { issueIdOrKey: "OPS-1", responseContentFormat: "html" })).data.fields.description).toStartWith("<p>Certs expire on the 3rd.</p><p><strong>Acceptance criteria</strong></p><ul><li>");

    const scrum = await signedIn("cloud-scrum-company");
    const panel = await call(scrum.c, scrum.f, "getJiraIssue", { issueIdOrKey: "PAY-318" });
    expect(panel.data.appliedContentFormat).toBe("html");
    expect(panel.data.fields.description).toContain('<div data-panel-type="warning"><p>Do not retry 4xx except 429.</p></div>');
    expect(panel.data.fields.description).toContain('<li data-type="task-item" data-local-id="ti-1"><input type="checkbox" checked>Retries 5 times with jittered backoff</li>');
    const comments = await call(scrum.c, scrum.f, "listJiraIssueComments", { issueIdOrKey: "PAY-318" });
    expect(comments.data.comments.map((x: { body: string; appliedContentFormat: string }) => [x.body, x.appliedContentFormat])).toEqual([["Multi-line comment,\nsecond line.", "markdown"], ["Edited, role-restricted.", "markdown"]]);
  });

  test("writes go through the REST fake's state: transitions with screens, conditions and hidden validators, comments, assignee, remote links, properties", async () => {
    const { f, c } = await signedIn("cloud-scrum-company");
    // A screen with a required resolution.
    const noResolution = await call(c, f, "transitionJiraIssue", { issueIdOrKey: "PAY-318", transitionName: "Won't do" });
    expect(noResolution.error).toEqual({ error: true, message: "resolution: Resolution is required.", statusCode: 400 });
    const done = await call(c, f, "transitionJiraIssue", { issueIdOrKey: "PAY-318", transitionId: "81", fields: { resolution: { name: "Duplicate" } } });
    expect(done.data).toMatchObject({ key: "PAY-318", transition: { id: "81", name: "Won't do" }, status: { id: "10007" } });
    expect((await rest(f, "GET", "/rest/api/3/issue/PAY-318?fields=status,resolution")).fields).toMatchObject({ status: { id: "10007" }, resolution: { name: "Duplicate" } });
    // A condition (assignee only) hides "Start" from someone else's issue.
    expect((await call(c, f, "transitionJiraIssue", { issueIdOrKey: "PAY-329", transitionName: "Start" })).error?.message).toMatch(/^Transition "Start" is not available for this issue/);
    // A validator on a field that isn't on the screen surfaces only on the POST.
    f.site.workflows["PAY Story workflow"]!.transitions.find((t) => t.id === "71")!.condition = undefined;
    const hidden = await call(c, f, "transitionJiraIssue", { issueIdOrKey: "PAY-330", transitionId: "71", fields: { resolution: { name: "Done" } } });
    expect(hidden.error?.message).toContain("fixVersions: Fix Version/s is required.");

    // Comments: markdown in, ADF stored, markdown back; then an edit by id.
    const added = await call(c, f, "addOrEditJiraIssueComment", { issueIdOrKey: "PAY-322", commentBody: "Merged in **PR 12**: [link](https://github.com/acme/payments/pull/12)" });
    expect(added.data.body).toBe("Merged in **PR 12**: [link](https://github.com/acme/payments/pull/12)");
    const stored = (await rest(f, "GET", "/rest/api/3/issue/PAY-322/comment")).comments.at(-1);
    expect(stored.body.content[0].content).toEqual([
      { type: "text", text: "Merged in " },
      { type: "text", text: "PR 12", marks: [{ type: "strong" }] },
      { type: "text", text: ": " },
      { type: "text", text: "link", marks: [{ type: "link", attrs: { href: "https://github.com/acme/payments/pull/12" } }] },
    ]);
    await call(c, f, "addOrEditJiraIssueComment", { issueIdOrKey: "PAY-322", commentId: added.data.id, commentBody: "- [x] merged\n- [ ] released" });
    const after = (await rest(f, "GET", "/rest/api/3/issue/PAY-322/comment")).comments;
    expect(after.map((x: { id: string }) => x.id)).toEqual([added.data.id]);
    expect(after[0].body.content[0]).toMatchObject({ type: "taskList", content: [{ attrs: { state: "DONE" } }, { attrs: { state: "TODO" } }] });

    // Assignee through editJiraIssue, and what the guard's refusal looks like.
    expect((await call(c, f, "editJiraIssue", { issueIdOrKey: "PAY-322", fields: { assignee: { accountId: JANE } } })).data.fields.assignee.accountId).toBe(JANE);
    expect((await rest(f, "GET", "/rest/api/3/issue/PAY-322?fields=assignee")).fields.assignee.accountId).toBe(JANE);
    await call(c, f, "editJiraIssue", { issueIdOrKey: "PAY-322", fields: { assignee: null } });
    expect((await rest(f, "GET", "/rest/api/3/issue/PAY-322?fields=assignee")).fields.assignee).toBeNull();
    expect((await call(c, f, "editJiraIssue", { issueIdOrKey: "PAY-322", fields: { assignee: { accountId: "nobody" } } })).error?.message).toBe("assignee: User 'nobody' does not exist.");
    await call(c, f, "editJiraIssue", { issueIdOrKey: "PAY-322", fields: { summary: "Renamed", labels: ["a", "b"], description: "## Plan\n\n1. first\n2. second" } });
    const edited = (await rest(f, "GET", "/rest/api/3/issue/PAY-322?fields=summary,labels,description")).fields;
    expect([edited.summary, edited.labels, edited.description.content.map((n: { type: string }) => n.type)]).toEqual(["Renamed", ["a", "b"], ["heading", "orderedList"]]);

    // Remote links have no globalId on this surface: a second create adds a second link.
    for (let n = 0; n < 2; n++) await call(c, f, "createJiraIssueRemoteIssueLink", { issueIdOrKey: "PAY-322", url: "https://github.com/acme/payments/pull/12", title: "PR 12", relationship: "mentioned in" });
    const links = await rest(f, "GET", "/rest/api/3/issue/PAY-322/remotelink");
    expect(links.map((l: { object: { url: string }; globalId?: string }) => [l.object.url, l.globalId])).toEqual([["https://github.com/acme/payments/pull/12", undefined], ["https://github.com/acme/payments/pull/12", undefined]]);
    const listed = await call(c, f, "listJiraIssueRemoteIssueLinks", { issueIdOrKey: "PAY-324" });
    expect(listed.data).toEqual([expect.objectContaining({ object: expect.objectContaining({ url: "https://github.com/acme/payments/pull/1180" }) })]);
    expect(listed.data[0].globalId).toBeUndefined();

    // Entity properties.
    expect((await call(c, f, "getJiraEntityProperty", { entityType: "issue", issueIdOrKey: "PAY-324" })).data.keys).toEqual([{ key: "hivemind" }]);
    await call(c, f, "editJiraEntityProperty", { entityType: "issue", issueIdOrKey: "PAY-322", propertyKey: "hivemind", value: { branch: "PAY-322-x" } });
    expect(await rest(f, "GET", "/rest/api/3/issue/PAY-322/properties/hivemind")).toEqual({ key: "hivemind", value: { branch: "PAY-322-x" } });
    expect((await call(c, f, "getJiraEntityProperty", { entityType: "issue", issueIdOrKey: "PAY-322", propertyKey: "hivemind" })).data.value).toEqual({ branch: "PAY-322-x" });
  });
});

describe("behaviour", () => {
  test("structuredContent goes only to recognised clientInfo.name values when the list is set (#213); the text is identical either way", async () => {
    const args = { jql: "project = PAY ORDER BY key", maxResults: 3 };
    const ours = await signedIn("cloud-scrum-company", { recognisedClients: ["claude-code", "cursor"] }, "hivemind");
    const known = await connect(ours.f, await LoopbackProvider.start("claude-code"));
    const ungated = await signedIn("cloud-scrum-company", {}, "hivemind");
    const a = await call(ours.c, ours.f, "searchJiraIssuesUsingJql", args);
    const b = await call(known, ours.f, "searchJiraIssuesUsingJql", args);
    const d = await call(ungated.c, ungated.f, "searchJiraIssuesUsingJql", args);
    expect(a.structured).toBeUndefined();
    expect(b.structured.issues.nodes).toHaveLength(3);
    expect(d.structured.issues.nodes).toHaveLength(3);
    expect(a.text).toBe(b.text);
  });

  test("past maxParallel calls in flight, or the hourly limit, the answer is 429 with only Retry-After (#171)", async () => {
    const f = await fake("cloud-scrum-company", { apiTokens: true, maxParallel: 2, latencyMs: 60, hourlyLimit: 8 });
    const auth = f.oauth.apiTokenAuthorization();
    const sid = await rawSession(f, auth);
    const burst = await Promise.all([1, 2, 3, 4, 5].map((n) => rpc(f, auth, toolCall(n, "getJiraCurrentUser", { cloudId: f.site.cloudId }), sid)));
    const limited = burst.filter((r) => r.status === 429);
    expect(burst.filter((r) => r.status === 200)).toHaveLength(2);
    expect(limited).toHaveLength(3);
    for (const r of limited) {
      expect(r.headers.get("retry-after")).toBe("1");
      expect([...r.headers.keys()].filter((h) => /ratelimit/i.test(h))).toEqual([]);
      expect(r.json).toEqual({ error: "too_many_requests", error_description: "Rate limit exceeded" });
    }
    // Hourly: 2 calls spent; 6 more pass, the next waits for the oldest to age out.
    for (let n = 0; n < 6; n++) expect((await rpc(f, auth, toolCall(10 + n, "getJiraCurrentUser", { cloudId: f.site.cloudId }), sid)).status).toBe(200);
    clock += 600_000;
    const over = await rpc(f, auth, toolCall(20, "getJiraCurrentUser", { cloudId: f.site.cloudId }), sid);
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBe(String(3600 - 600));
    clock += 3000_000;
    expect((await rpc(f, auth, toolCall(21, "getJiraCurrentUser", { cloudId: f.site.cloudId }), sid)).status).toBe(200);
    // Through the SDK a 429 is a StreamableHTTPError with that code.
    const { c, t } = client(f, { headers: { Authorization: auth } });
    await c.connect(t);
    open.push({ close: () => c.close() });
    const sdk = await Promise.allSettled([1, 2, 3].map(() => c.callTool({ name: "getJiraCurrentUser", arguments: { cloudId: f.site.cloudId } })));
    expect(sdk.some((r) => r.status === "rejected" && r.reason instanceof StreamableHTTPError && r.reason.code === 429)).toBe(true);
  });

  test("a Jira fault behind the MCP server comes back as Rovo's retry-later tool error, and the next call answers", async () => {
    const site = SITES.get("cloud-scrum-company")!;
    const f = await createFakeRovoMcp({ ...site, faults: [{ name: "burst", match: { method: "POST", path: "/rest/api/3/search/jql", nth: 1, times: 1 }, status: 429, headers: { "Retry-After": "2" } }] }, { now: () => new Date(clock) });
    open.push(f);
    const p = await LoopbackProvider.start();
    const c = await connect(f, p);
    expect((await call(c, f, "searchJiraIssuesUsingJql", { jql: "project = PAY" })).error).toEqual({ error: true, message: "We are having trouble completing this action. Please try again shortly.", statusCode: 429 });
    expect((await call(c, f, "searchJiraIssuesUsingJql", { jql: "project = PAY" })).isError).toBe(false);
  });

  test("search (Rovo semantic search) costs credits on every call; the Jira tools cost none", async () => {
    const { f, c } = await signedIn("cloud-scrum-company");
    await call(c, f, "searchJiraIssuesUsingJql", { jql: "project = PAY" });
    const hits = await call(c, f, "search", { query: "webhook" });
    expect(hits.data.results.map((r: { title: string }) => r.title)).toContain("PAY-318: Retry failed webhooks");
    expect(f.requests.filter((r) => r.kind === "tool").map((r) => [r.tool, r.credits])).toEqual([["searchJiraIssuesUsingJql", 0], ["search", 10]]);
  });

  test("the transport: /v1/sse is gone, GET has no stream, a stale session is 404 -32001, a request before initialize is refused", async () => {
    const f = await fake("cloud-scrum-company", { apiTokens: true });
    const auth = f.oauth.apiTokenAuthorization();
    expect((await fetch(`${f.origin}/v1/sse`)).status).toBe(410);
    expect((await fetch(f.url, { headers: { Authorization: auth } })).status).toBe(405);
    const stale = await rpc(f, auth, toolCall(1, "getJiraCurrentUser", { cloudId: f.site.cloudId }), "gone");
    expect(stale.status).toBe(404);
    expect(stale.json.error).toEqual({ code: -32001, message: "Session not found" });
    expect((await rpc(f, auth, toolCall(1, "getJiraCurrentUser", { cloudId: f.site.cloudId }))).json.error.code).toBe(-32000);
    const sid = await rawSession(f, auth);
    const both = await rpc(f, auth, [toolCall(1, "getJiraCurrentUser", { cloudId: f.site.cloudId }), { jsonrpc: "2.0", id: 2, method: "resources/read", params: {} }], sid);
    expect(both.json.map((m: { id: number; error?: { code: number } }) => [m.id, m.error?.code])).toEqual([[1, undefined], [2, -32601]]);
  });
});
