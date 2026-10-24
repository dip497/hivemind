// The fake Atlassian Rovo MCP server (design §9.2, §15): Streamable HTTP at `/v2/mcp`, OAuth 2.1
// sign-in (metadata, dynamic client registration, PKCE S256, a loopback redirect, rotating refresh
// tokens) or an admin-enabled scoped API token, and the Jira tools the sync uses. Tools answer
// through the REST fake's in-process `invoke`, so a sync over MCP and one over REST see one Jira.
// JSON-RPC is hand-written rather than the SDK's server: the quirks under test (tools/list pages,
// per-session clientInfo gating of structuredContent, HTTP 429s before JSON-RPC, OAuth on the same
// origin) sit below what McpServer exposes. fixtures/README.md ("The fake Rovo MCP server") says
// how a test uses it and lists every ASSUMED shape.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createFakeJira, type FakeJira, type FakeJiraOptions } from "./server.js";
import { ROVO, toolCatalogue, type RovoTool, type ToolResult } from "./mcp-tools.js";
import type { Site } from "./site.js";

type Json = Record<string, unknown>;

export interface FakeRovoMcpOptions {
  /** The clock for token lifetimes and the hourly limit. Shared with the REST fake when it creates one. */
  now?: () => Date;
  /** Options for the REST fake created when `createFakeRovoMcp` gets a site rather than a running fake. */
  jira?: FakeJiraOptions;
  /** Access-token lifetime. Default 28800 s, the `expires_in` of a live token. */
  accessTtlS?: number;
  /**
   * How long a rotated-out refresh token still works (ASSUMED: identity servers that rotate allow
   * a short reuse window; Atlassian doesn't say). Reuse after it revokes the whole grant. The SDK's
   * transport can refresh twice at once (its GET stream and a POST both meet the 401), so 0 shows
   * what a client that doesn't serialize refreshes would hit. Default 10 s.
   */
  refreshGraceS?: number;
  /** A refresh token unused for this long is refused with `unauthorized_client` (#260: about 4 days idle on v2). Default 4 days. */
  refreshIdleS?: number;
  /**
   * Every registered client_id is forgotten once it has been granted tokens, as the move of DCR
   * to the Atlassian Identity server did (CHANGE-3170): a client that reuses a cached client_id
   * gets `invalid_client` and has to register again. `oauth.forgetClients()` does it on demand.
   */
  forgetClients?: boolean;
  /** `false` simulates an admin who removed the loopback entries from the domain allowlist. Default true. */
  allowLoopback?: boolean;
  /** Non-loopback redirect URI prefixes an admin allowed. */
  allowedRedirects?: string[];
  /** `false` = the consent screen is declined (`error=access_denied`). Default true. */
  consent?: boolean;
  /**
   * A stale grant (#283): Jira tools answer `{"code":403,"message":"The app is not installed on
   * this instance"}` and getAccessibleAtlassianResources lists the site without `scopes`.
   * `oauth.setAppInstalled()` flips it.
   */
  appNotInstalled?: boolean;
  /** API-token auth, which an org admin must enable (Administration → Rovo → Rovo MCP server → Authentication). */
  apiTokens?: boolean;
  /** The scoped API token's scopes. Default: read, write and search `:jira:agent-interface`. */
  apiTokenScopes?: string[];
  /**
   * `structuredContent` goes only to clients whose `clientInfo.name` is listed (#213). Omitted =
   * every client gets it.
   */
  recognisedClients?: string[];
  /** More MCP calls than this in flight → 429 with only `Retry-After` (#171). Default 20. */
  maxParallel?: number;
  /** Tool calls per rolling hour, org-wide; past it → 429 with only `Retry-After`. Default: no limit. */
  hourlyLimit?: number;
  /** Each tool call takes this long, so parallel calls overlap. Default 0. */
  latencyMs?: number;
  /** The `manage_jira` group (getJiraWorkflows, …), off by default on real sites. */
  manageJira?: boolean;
  /** Also answer the tool names from before CHANGE-3452 (`findJiraIssueAssignableUsers`). */
  oldNames?: boolean;
  /** Operations this site's catalogue lacks: "Unknown operation" and absent from tools/list (#282 saw listJiraBoards / listJiraBoardSprints missing). */
  unavailable?: string[];
  port?: number;
}

export interface McpLoggedRequest {
  /** `http` for every HTTP request (OAuth, metadata, MCP); `tool` once per tools/call. */
  kind: "http" | "tool";
  method: string;
  path: string;
  status: number;
  auth?: "oauth" | "apiToken";
  /** The session's `clientInfo.name`. */
  client?: string;
  /** JSON-RPC method of an MCP request, or the tool name of a `tool` entry. */
  rpc?: string;
  tool?: string;
  args?: Json;
  isError?: boolean;
  /** Rovo credits the call consumed: `search` costs up to 10 per call; Jira tools cost none. */
  credits: number;
}

export interface RegisteredClient { client_id: string; client_name?: string; redirect_uris: string[]; scope?: string; client_id_issued_at: number }

export interface FakeRovoMcpOAuth {
  /** Registered clients by client_id. */
  clients: Map<string, RegisteredClient>;
  /** Every register / authorize / token call, in order. */
  log: { endpoint: "register" | "authorize" | "token"; grant?: string; status: number; error?: string; client_id?: string }[];
  /** Forget every registered client (CHANGE-3170). */
  forgetClients(): void;
  /** Make every access token expire now, so the next call needs a refresh. */
  expireAccessTokens(): void;
  /** Make the grant stale (`false`, #283) or fresh again. */
  setAppInstalled(installed: boolean): void;
  /** The Authorization header for the API token: `scoped` (works when enabled) or `classic` (always refused). */
  apiTokenAuthorization(kind?: "scoped" | "classic"): string;
}

export interface FakeRovoMcp {
  /** The MCP endpoint, `http://127.0.0.1:<port>/v2/mcp`; add `?tools=all` for the flat tool list. */
  url: string;
  origin: string;
  /** The live site model, shared with `jira`. */
  site: Site;
  /** The REST fake behind it: the same Jira over REST. */
  jira: FakeJira;
  requests: McpLoggedRequest[];
  oauth: FakeRovoMcpOAuth;
  close(): Promise<void>;
}

const DEFAULT_SCOPES = ["read:jira:agent-interface", "write:jira:agent-interface", "search:jira:agent-interface"];

export async function createFakeRovoMcp(input: Site | FakeJira, opts: FakeRovoMcpOptions = {}): Promise<FakeRovoMcp> {
  const owned = !("invoke" in input);
  const jira = owned ? await createFakeJira(input, { now: opts.now, ...opts.jira }) : input;
  const site = jira.site;
  if (site.deployment !== "Cloud") throw new Error("Rovo MCP is Cloud only (design §9.0)");
  const now = () => (opts.now ? opts.now().getTime() : Date.now());
  const requests: McpLoggedRequest[] = [];
  const accessTtl = (opts.accessTtlS ?? ROVO.accessTtlS) * 1000;
  const refreshIdle = (opts.refreshIdleS ?? 4 * 86400) * 1000;
  let appInstalled = !opts.appNotInstalled;
  let inFlight = 0;
  const hourly: number[] = [];
  const me = site.users.find((u) => u.accountId === site.myself)!;
  const apiToken = { email: me.emailAddress ?? "fake@example.com", scoped: "fake-rovo-scoped-token", classic: "fake-rovo-classic-token" };
  const apiScopes = opts.apiTokenScopes ?? DEFAULT_SCOPES;

  // ── OAuth state ──────────────────────────────────────────────────────────────────────────
  const clients = new Map<string, RegisteredClient>();
  const codes = new Map<string, { client_id: string; redirect_uri: string; challenge: string; resource?: string; scopes: string[]; expires: number }>();
  const access = new Map<string, { client_id: string; expires: number; scopes: string[] }>();
  /** Refresh tokens; a rotated-out one stays (with `rotatedAt`) so late reuse revokes its whole family. */
  const refresh = new Map<string, { client_id: string; family: string; issued: number; rotatedAt?: number; scope?: string }>();
  const grace = (opts.refreshGraceS ?? 10) * 1000;
  const oauthLog: FakeRovoMcpOAuth["log"] = [];
  const token = (prefix: string) => `${prefix}-${randomBytes(18).toString("base64url")}`;

  const isLoopback = (u: URL) => u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]");
  const redirectAllowed = (raw: string) => {
    let u: URL;
    try { u = new URL(raw); } catch { return false; }
    if (isLoopback(u)) return opts.allowLoopback !== false;
    return (opts.allowedRedirects ?? []).some((p) => raw.startsWith(p));
  };

  /** Granted scopes: what was asked for and is supported; nothing asked = the Jira defaults. */
  const granted = (asked?: string) => {
    const want = (asked ?? "").split(" ").filter(Boolean);
    return want.length ? want.filter((x) => ROVO.scopes.includes(x)) : [...DEFAULT_SCOPES];
  };
  const issueTokens = (client_id: string, family: string, scopes: string[]) => {
    const a = token("at");
    access.set(a, { client_id, expires: now() + accessTtl, scopes });
    // A refresh token only with offline_access, as Atlassian's identity server does.
    const r = scopes.includes("offline_access") ? token("rt") : undefined;
    if (r) refresh.set(r, { client_id, family, issued: now(), scope: scopes.join(" ") });
    if (opts.forgetClients) clients.delete(client_id);
    return { access_token: a, token_type: "Bearer", expires_in: Math.round(accessTtl / 1000), ...(r ? { refresh_token: r } : {}), scope: scopes.join(" ") };
  };

  // ── HTTP plumbing ────────────────────────────────────────────────────────────────────────
  type Out = { status: number; body?: unknown; headers?: Record<string, string> };
  const oauthError = (status: number, error: string, error_description: string): Out => ({ status, body: { error, error_description } });

  let origin = "";
  const mcpPath = "/v2/mcp";
  const resourceMetadataUrl = () => `${origin}/.well-known/oauth-protected-resource${mcpPath}`;
  const issuer = () => `${origin}${ROVO.issuerPath}`;
  const protectedResource = () => ({
    resource: `${origin}${mcpPath}`,
    authorization_servers: [issuer()],
    bearer_methods_supported: ["header"],
    scopes_supported: ROVO.scopes,
  });
  const authServer = () => ({
    issuer: issuer(),
    authorization_endpoint: `${origin}${ROVO.paths.authorize}`,
    token_endpoint: `${origin}${ROVO.paths.token}`,
    registration_endpoint: `${origin}${ROVO.paths.register}`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ROVO.scopes,
    revocation_endpoint: `${origin}${ROVO.paths.revoke}`,
  });

  const register = (body: unknown): Out => {
    const b = (body ?? {}) as { redirect_uris?: unknown; client_name?: string; scope?: string; token_endpoint_auth_method?: string };
    const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.filter((u): u is string => typeof u === "string") : [];
    let out: Out;
    if (uris.length === 0) out = oauthError(400, "invalid_redirect_uri", "redirect_uris is required.");
    else if (!uris.every(redirectAllowed)) out = oauthError(400, "invalid_redirect_uri", `Redirect URI not allowed by your organization's domain allowlist: ${uris.find((u) => !redirectAllowed(u))}`);
    else {
      const c: RegisteredClient = { client_id: token("client"), client_name: b.client_name, redirect_uris: uris, scope: b.scope, client_id_issued_at: Math.floor(now() / 1000) };
      clients.set(c.client_id, c);
      out = { status: 201, body: { ...c, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] } };
    }
    oauthLog.push({ endpoint: "register", status: out.status, error: (out.body as Json).error as string | undefined, client_id: (out.body as Json).client_id as string | undefined });
    return out;
  };

  /** The consent screen, auto-approved by the site's `myself`: redirects to the client's loopback URI. */
  const authorize = (q: URLSearchParams): Out => {
    const client_id = q.get("client_id") ?? "";
    const redirect_uri = q.get("redirect_uri") ?? "";
    const c = clients.get(client_id);
    const log = (o: Out, error?: string) => { oauthLog.push({ endpoint: "authorize", status: o.status, error, client_id }); return o; };
    // Before the redirect URI is trusted, errors are shown on the page, never redirected.
    if (!c) return log({ status: 400, body: { error: "invalid_client", error_description: "Unknown client_id. Register the client again." } }, "invalid_client");
    if (!c.redirect_uris.includes(redirect_uri) || !redirectAllowed(redirect_uri)) return log({ status: 400, body: { error: "invalid_request", error_description: "redirect_uri is not registered for this client or not allowed." } }, "invalid_redirect_uri");
    const back = (params: Record<string, string>) => {
      const u = new URL(redirect_uri);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      const state = q.get("state");
      if (state !== null) u.searchParams.set("state", state);
      return { status: 302, headers: { Location: u.toString() } };
    };
    if (q.get("response_type") !== "code") return log(back({ error: "unsupported_response_type" }), "unsupported_response_type");
    const challenge = q.get("code_challenge");
    if (!challenge || q.get("code_challenge_method") !== "S256") return log(back({ error: "invalid_request", error_description: "PKCE with code_challenge_method=S256 is required." }), "pkce_required");
    const resource = q.get("resource") ?? undefined;
    if (resource !== undefined && !resource.startsWith(`${origin}${mcpPath}`)) return log(back({ error: "invalid_target", error_description: "Unknown resource." }), "invalid_target");
    if (opts.consent === false) return log(back({ error: "access_denied", error_description: "The user denied access." }), "access_denied");
    const code = token("code");
    codes.set(code, { client_id, redirect_uri, challenge, resource, scopes: granted(q.get("scope") ?? undefined), expires: now() + 60_000 });
    return log(back({ code }));
  };

  const tokenEndpoint = (form: URLSearchParams): Out => {
    const grant = form.get("grant_type") ?? "";
    const client_id = form.get("client_id") ?? "";
    const done = (o: Out) => { oauthLog.push({ endpoint: "token", grant, status: o.status, error: (o.body as Json | undefined)?.error as string | undefined, client_id }); return o; };
    if (!clients.has(client_id)) return done(oauthError(401, "invalid_client", "Client authentication failed: unknown client_id."));
    if (grant === "authorization_code") {
      const code = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? "");
      if (!code || code.expires < now() || code.client_id !== client_id) return done(oauthError(400, "invalid_grant", "The authorization code is invalid or has expired."));
      if (form.get("redirect_uri") !== code.redirect_uri) return done(oauthError(400, "invalid_grant", "redirect_uri does not match the authorization request."));
      const verifier = form.get("code_verifier") ?? "";
      if (createHash("sha256").update(verifier).digest("base64url") !== code.challenge) return done(oauthError(400, "invalid_grant", "PKCE verification failed."));
      return done({ status: 200, body: issueTokens(client_id, token("fam"), code.scopes), headers: { "Cache-Control": "no-store" } });
    }
    if (grant === "refresh_token") {
      const rt = form.get("refresh_token") ?? "";
      const r = refresh.get(rt);
      if (!r || r.client_id !== client_id) return done(oauthError(400, "invalid_grant", "Unknown refresh token."));
      if (r.rotatedAt !== undefined && now() - r.rotatedAt > grace) {
        // Reuse of a rotated-out refresh token: the whole grant is revoked (OAuth 2.1 §4.3.1).
        for (const [k, v] of refresh) if (v.family === r.family) refresh.delete(k);
        return done(oauthError(400, "invalid_grant", "Refresh token reuse detected; the grant has been revoked."));
      }
      // #260: an idle refresh token dies with unauthorized_client, not invalid_grant.
      if (now() - r.issued > refreshIdle) { refresh.delete(rt); return done(oauthError(400, ROVO.refreshIdleError.error, ROVO.refreshIdleError.error_description)); }
      r.rotatedAt ??= now();
      return done({ status: 200, body: issueTokens(client_id, r.family, granted(r.scope)), headers: { "Cache-Control": "no-store" } });
    }
    return done(oauthError(400, "unsupported_grant_type", `Unsupported grant_type ${grant}.`));
  };

  // ── MCP auth ─────────────────────────────────────────────────────────────────────────────
  const unauthorized = (description: string): Out => ({
    status: 401,
    headers: { "WWW-Authenticate": `Bearer error="invalid_token", error_description="${description}", resource_metadata="${resourceMetadataUrl()}"` },
    body: { error: "invalid_token" },
  });
  type Caller = { kind: "oauth" | "apiToken"; scopes: string[] };
  const authenticate = (req: IncomingMessage): Caller | Out => {
    const h = req.headers.authorization ?? "";
    if (h.startsWith("Bearer ")) {
      const a = access.get(h.slice(7));
      if (!a || a.expires <= now()) return unauthorized(a ? "The access token expired" : "Missing or invalid access token");
      return { kind: "oauth", scopes: a.scopes };
    }
    if (h.startsWith("Basic ")) {
      const [email, secret] = Buffer.from(h.slice(6), "base64").toString().split(":");
      if (!opts.apiTokens) return { status: 401, body: { error: "invalid_token", error_description: "API token authentication is not enabled for this organization." } };
      const ok = email === apiToken.email && secret === apiToken.scoped && DEFAULT_SCOPES.every((s) => apiScopes.includes(s));
      return ok ? { kind: "apiToken", scopes: apiScopes } : { status: 401, body: { error: "invalid_token", error_description: "API token must be scoped with read:jira:agent-interface, write:jira:agent-interface and search:jira:agent-interface." } };
    }
    return unauthorized("Missing or invalid access token");
  };

  // ── MCP sessions and JSON-RPC ────────────────────────────────────────────────────────────
  const sessions = new Map<string, { client?: string; flat: boolean }>();
  const catalogue = toolCatalogue({ manageJira: !!opts.manageJira, oldNames: !!opts.oldNames, unavailable: opts.unavailable ?? [] });

  const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

  const listTools = (flat: boolean, cursor: unknown) => {
    const all = flat ? catalogue.flat : catalogue.primary;
    let offset = 0;
    if (cursor !== undefined) {
      offset = Number(Buffer.from(String(cursor), "base64url").toString());
      if (!Number.isInteger(offset) || offset < 0 || offset >= all.length) return undefined;
    }
    const page = all.slice(offset, offset + ROVO.pageSize).map(toolJson);
    return { tools: page, ...(offset + ROVO.pageSize < all.length ? { nextCursor: Buffer.from(String(offset + ROVO.pageSize)).toString("base64url") } : {}) };
  };

  const callTool = async (session: { client?: string; flat: boolean }, caller: Caller, params: Json): Promise<Json> => {
    const name = String(params.name ?? "");
    const args = (params.arguments ?? {}) as Json;
    // Plain /v2/mcp answers only its primary tools; the rest go through discover / execute*.
    const tool = session.flat ? catalogue.byName.get(name) : catalogue.primary.find((t) => t.name === name);
    if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs));
    if (!tool) {
      requests.push({ kind: "tool", method: "POST", path: mcpPath, status: 200, auth: caller.kind, client: session.client, tool: name, args, isError: true, credits: 0 });
      throw Object.assign(new Error(`Tool ${name} not found`), { rpc: -32602 });
    }
    const result: ToolResult = tool.run({ jira, site, appInstalled, scopes: caller.scopes, catalogue }, args);
    const structured = result.structured !== undefined && (!opts.recognisedClients || opts.recognisedClients.includes(session.client ?? ""));
    requests.push({ kind: "tool", method: "POST", path: mcpPath, status: 200, auth: caller.kind, client: session.client, tool: tool.name, args, isError: !!result.isError, credits: tool.credits });
    return {
      content: [{ type: "text", text: result.text }],
      ...(structured ? { structuredContent: result.structured } : {}),
      ...(result.isError ? { isError: true } : {}),
    };
  };

  const rpc = async (msg: Json, sessionId: string | undefined, flat: boolean, caller: Caller): Promise<{ reply?: Json; newSession?: string }> => {
    const id = msg.id;
    const method = String(msg.method ?? "");
    const params = (msg.params ?? {}) as Json;
    if (method === "initialize") {
      const sid = token("session");
      const info = params.clientInfo as { name?: string } | undefined;
      sessions.set(sid, { client: info?.name, flat });
      const asked = String(params.protocolVersion ?? "");
      return {
        newSession: sid,
        reply: { jsonrpc: "2.0", id, result: {
          // The live server answers 2025-06-18; an older client gets its own version back.
          protocolVersion: /^\d{4}-\d\d-\d\d$/.test(asked) && asked < ROVO.protocolVersion ? asked : ROVO.protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: ROVO.serverInfo,
          instructions: ROVO.instructions,
        } },
      };
    }
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) return { reply: rpcError(id ?? null, -32000, "Bad Request: no valid session; send initialize first") };
    if (id === undefined) return {}; // a notification
    if (method === "ping") return { reply: { jsonrpc: "2.0", id, result: {} } };
    if (method === "tools/list") {
      const page = listTools(session.flat, params.cursor);
      return { reply: page ? { jsonrpc: "2.0", id, result: page } : rpcError(id, -32602, "Invalid cursor") };
    }
    if (method === "tools/call") {
      try { return { reply: { jsonrpc: "2.0", id, result: await callTool(session, caller, params) } }; }
      catch (e) { return { reply: rpcError(id, (e as { rpc?: number }).rpc ?? -32603, (e as Error).message) }; }
    }
    return { reply: rpcError(id, -32601, `Method not found: ${method}`) };
  };

  const tooMany = (retryAfterS: number): Out => ({ status: 429, headers: { "Retry-After": String(retryAfterS) }, body: ROVO.rateLimited });

  const mcp = async (req: IncomingMessage, url: URL, raw: string): Promise<Out & { rpc?: string; auth?: "oauth" | "apiToken"; client?: string }> => {
    const auth = authenticate(req);
    if ("status" in auth) return auth;
    const sid = req.headers["mcp-session-id"] as string | undefined;
    if (req.method === "GET") return { status: 405, headers: { Allow: "POST, DELETE" }, auth: auth.kind };
    if (req.method === "DELETE") { if (sid) sessions.delete(sid); return { status: 200, auth: auth.kind }; }
    if (req.method !== "POST") return { status: 405, headers: { Allow: "POST, DELETE" } };
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return { status: 400, body: rpcError(null, -32700, "Parse error") }; }
    const msgs = (Array.isArray(body) ? body : [body]) as Json[];
    const names = msgs.map((m) => String(m.method ?? "")).join(",");
    if (sid && !sessions.has(sid) && !msgs.some((m) => m.method === "initialize")) return { status: 404, body: rpcError(null, -32001, "Session not found"), rpc: names };
    // Limits apply per MCP request, before JSON-RPC is read, and say only when to come back (#171).
    const calls = msgs.filter((m) => m.method === "tools/call").length;
    if (inFlight >= (opts.maxParallel ?? 20)) return { ...tooMany(1), rpc: names, auth: auth.kind };
    if (calls && opts.hourlyLimit !== undefined) {
      const t = now();
      while (hourly.length && hourly[0]! <= t - 3_600_000) hourly.shift();
      if (hourly.length + calls > opts.hourlyLimit) return { ...tooMany(Math.max(1, Math.ceil((hourly[0]! + 3_600_000 - t) / 1000))), rpc: names, auth: auth.kind };
      for (let k = 0; k < calls; k++) hourly.push(t);
    }
    inFlight++;
    try {
      const flat = url.searchParams.get("tools") === "all";
      const out = await Promise.all(msgs.map((m) => rpc(m, sid, flat, auth)));
      const newSession = out.find((o) => o.newSession)?.newSession;
      const replies = out.map((o) => o.reply).filter((r): r is Json => !!r);
      const client = sessions.get(newSession ?? sid ?? "")?.client;
      const headers = newSession ? { "Mcp-Session-Id": newSession } : undefined;
      if (replies.length === 0) return { status: 202, headers, rpc: names, auth: auth.kind, client };
      return { status: 200, headers, body: Array.isArray(body) ? replies : replies[0], rpc: names, auth: auth.kind, client };
    } finally {
      inFlight--;
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const raw = await readBody(req);
    const method = (req.method ?? "GET").toUpperCase();
    const path = url.pathname;
    let out: Out & { rpc?: string; auth?: "oauth" | "apiToken"; client?: string };
    if (path === mcpPath) out = await mcp(req, url, raw);
    else if (path === "/v1/sse" || path.startsWith("/v1/sse/")) out = { status: 410, body: { error: "gone", error_description: ROVO.sseGone } };
    // Only the path-qualified metadata exists; the bare /.well-known/oauth-protected-resource is a 404 (live, 2026-10-24).
    else if (method === "GET" && path === `/.well-known/oauth-protected-resource${mcpPath}`) out = { status: 200, body: protectedResource() };
    else if (method === "GET" && path === `/.well-known/oauth-authorization-server${ROVO.issuerPath}`) out = { status: 200, body: authServer() };
    else if (method === "POST" && path === ROVO.paths.register) { let b: unknown; try { b = JSON.parse(raw); } catch { b = undefined; } out = register(b); }
    else if (method === "GET" && path === ROVO.paths.authorize) out = authorize(url.searchParams);
    else if (method === "POST" && path === ROVO.paths.token) out = tokenEndpoint(new URLSearchParams(raw));
    else if (method === "POST" && path === ROVO.paths.revoke) {
      const t = new URLSearchParams(raw).get("token") ?? "";
      access.delete(t);
      refresh.delete(t);
      out = { status: 200 };
    } else out = { status: 404, body: { error: "not_found" } };
    requests.push({ kind: "http", method, path, status: out.status, auth: out.auth, client: out.client, rpc: out.rpc, credits: 0 });
    const headers: Record<string, string> = { ...out.headers };
    if (out.body === undefined) { res.writeHead(out.status, headers); res.end(); return; }
    headers["Content-Type"] = "application/json";
    res.writeHead(out.status, headers);
    res.end(JSON.stringify(out.body));
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => { res.writeHead(500, { "Content-Type": "text/plain" }); res.end(String(e instanceof Error ? e.stack : e)); });
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url: `${origin}${mcpPath}`,
    origin,
    site,
    jira,
    requests,
    oauth: {
      clients,
      log: oauthLog,
      forgetClients: () => clients.clear(),
      expireAccessTokens: () => { for (const a of access.values()) a.expires = 0; },
      setAppInstalled: (installed) => { appInstalled = installed; },
      apiTokenAuthorization: (kind = "scoped") => `Basic ${Buffer.from(`${apiToken.email}:${kind === "scoped" ? apiToken.scoped : apiToken.classic}`).toString("base64")}`,
    },
    close: async () => {
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
      if (owned) await jira.close();
    },
  };
}

function toolJson(t: RovoTool): Json {
  return {
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: t.annotations,
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
