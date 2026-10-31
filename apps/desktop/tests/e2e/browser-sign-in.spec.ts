// An agent signing in on a Browser tile: the person says yes on the tile, the app types the password
// on the saved site alone, and nothing an agent holds shows it. Or the person signs in themselves,
// which an agent holding the page does not get to watch.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocket as Socket } from "ws";
import { tileToken } from "@hivemind/agent-host/hooks/token";

const PORT = String(9950 + Math.floor(Math.random() * 40));
const PASSWORD = "not a real pass/word+1";
/** What the person types themselves: no saved sign-in knows it, so only the guard can keep it from an agent. */
const TYPED = "typed by the person 9";
const ud = fs.mkdtempSync(path.join(os.tmpdir(), "hm-signin-"));
const envFile = path.join(ud, "agent-env.txt");
const cli = path.resolve(process.cwd(), "../cli/src/index.ts");
let app: ElectronApplication;
let page: Page;
let tile = "";
let target = "";
let agentQuery = "";
let agentEnv: Record<string, string> = {};
const posts: { site: string; body: string }[] = [];
let good = "";
let other = "";

const FORM = (extra = "") => `<!doctype html><title>sign in</title><form method=post action=/session ${extra}><label>Email <input type=email name=email></label><label>Password <input type=password name=password></label><button>Sign in</button></form>`;
function site(name: string): http.Server {
  return http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.method === "POST") {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        const body = decodeURIComponent(b.replace(/\+/g, " "));
        posts.push({ site: name, body });
        if (req.url === "/echoed") return void res.end(`<!doctype html><title>${/password=(.*)/.exec(body)?.[1]}</title><h1>signed in</h1>`);
        res.writeHead(302, { location: "/in" });
        res.end();
      });
      return;
    }
    if (req.url === "/login") return void res.end(FORM());
    if (req.url === "/echoes") return void res.end(FORM().replace("/session", "/echoed"));
    if (req.url === "/stays") return void res.end(FORM(`onsubmit="document.title='kept';return false"`));
    if (req.url === "/framed") return void res.end(`<!doctype html><title>framed</title><iframe src="/login" width=400 height=300></iframe>`);
    if (req.url === "/away") { res.writeHead(302, { location: `${other}/login` }); return void res.end(); }
    if (req.url === "/two") return void res.end(`<!doctype html><title>two</title><form id=f method=post action=/session><label>Email <input type=email name=email id=email></label><button>Next</button></form><script>
      f.addEventListener("submit", (e) => { if (document.querySelector("[name=password]")) return; e.preventDefault(); email.type = "hidden"; const p = document.createElement("input"); p.type = "password"; p.name = "password"; f.prepend(p); });</script>`);
    res.end(`<!doctype html><title>in</title><h1>signed in</h1>`);
  });
}
const a = site("good");
const b = site("other");

/** `hive ctl browser …` as the agent in this frame's terminal runs it. */
function agentRuns(...args: string[]): Promise<{ code: number | null; out: string; json: Record<string, unknown> }> {
  return new Promise((resolve) => {
    const c = spawn("bun", [cli, "ctl", "browser", ...args, "--json"], { env: { ...process.env, ...agentEnv }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("close", (code) => {
      let json: Record<string, unknown> = {};
      try { json = JSON.parse(out.trim().split("\n").pop() ?? "{}"); } catch { /* not JSON */ }
      resolve({ code, out, json });
    });
  });
}
const go = (url: string) => page.evaluate(([id, to]) => window.hive.browserCdp(id!, "Page.navigate", { url: to }), [tile, url]);
const evaluate = <T,>(expression: string) => page.evaluate(async ([id, e]) => ((await window.hive.browserCdp(id!, "Runtime.evaluate", { expression: e, returnByValue: true })) as { result: { value: unknown } }).result.value, [tile, expression]) as Promise<T>;
const askBar = () => page.locator(`.react-flow__node-browser[data-id="${tile}"] [data-person-ask]`);
const press = (name: string) => askBar().getByRole("button", { name }).click();
const saveSignIn = (name: string, url: string) => page.evaluate(([n, u, p]) => window.hive.browserSignInSave!({ name: n!, url: u!, username: "me@example.com", password: p! }), [name, url, PASSWORD]);

/** All an agent holding the page is told, and a way to ask it things. */
async function holdThePage() {
  const version = (await (await fetch(`http://127.0.0.1:${PORT}/json/version${agentQuery}`)).json()) as { webSocketDebuggerUrl: string };
  const ws = new Socket(version.webSocketDebuggerUrl);
  await new Promise((r) => ws.once("open", r));
  const heard: string[] = [];
  let n = 0;
  const waiting = new Map<number, (m: { result?: Record<string, unknown>; error?: { message: string } }) => void>();
  ws.on("message", (d: Buffer) => { const text = d.toString(); heard.push(text); const m = JSON.parse(text); waiting.get(m.id)?.(m); waiting.delete(m.id); });
  const send = (method: string, params: object = {}, sessionId?: string) => new Promise<{ result?: Record<string, unknown>; error?: { message: string } }>((resolve) => {
    const id = ++n;
    waiting.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const sessionId = (await send("Target.attachToTarget", { targetId: target, flatten: true })).result!.sessionId as string;
  await send("Network.enable", {}, sessionId);
  return { ws, send, sessionId, heard };
}

test.beforeAll(async () => {
  await new Promise<void>((r) => a.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => b.listen(0, "127.0.0.1", r));
  good = `http://127.0.0.1:${(a.address() as { port: number }).port}`;
  other = `http://localhost:${(b.address() as { port: number }).port}`;
  const env = { ...process.env, HIVEMIND_BROWSER_CDP: "1", HIVEMIND_BROWSER_CDP_PORT: PORT } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.resolve("out/main/index.js"), "--no-sandbox", `--user-data-dir=${ud}`], cwd: path.resolve("."), env });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
  await page.evaluate(() => window.hive.settingsSet("plugins.state.tool:@hivemind/web", { enabled: true }));
  await page.keyboard.press("6");
  const frame = (await page.locator(".react-flow__node-frame").last().getAttribute("data-id"))!;
  const open = (kind: string) => page.evaluate(([f, k]) => window.dispatchEvent(new CustomEvent("hivemind:frame-open", { detail: { frameId: f, kind: k } })), [frame, kind]);
  await open("browser");
  await expect(page.locator(".react-flow__node-browser")).toHaveCount(1);
  tile = (await page.locator(".react-flow__node-browser").last().getAttribute("data-id"))!;
  await open("shell");
  const term = page.locator(".react-flow__node-terminal").last();
  target = await page.evaluate(async (id) => {
    for (let i = 0; i < 100; i++) {
      try { return ((await window.hive.browserCdp(id, "Target.getTargetInfo", {})) as { targetInfo: { targetId: string } }).targetInfo.targetId; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    throw new Error("the tile never showed a page");
  }, tile);

  // What the terminal was given, as an agent in it would read it.
  await term.locator(".xterm-screen").click();
  // Each try is typed again, and rewrites the file: what a whole one said is kept as it is read.
  let printed = "";
  await expect.poll(async () => {
    await page.keyboard.type(`env | grep -E '^(HIVE|HCP|AGENT_BROWSER)' > ${envFile}\n`);
    const now = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
    if (now.includes("AGENT_BROWSER_CDP=http")) printed = now;
    return !!printed;
  }, { timeout: 20_000, intervals: [1500] }).toBe(true);
  agentEnv = Object.fromEntries(printed.trim().split("\n").map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
  // Who it is when the CLI asks, as an agent's tile is given.
  const shell = (await term.getAttribute("data-id"))!;
  await expect.poll(() => fs.existsSync(path.join(ud, "hcp.token"))).toBe(true);
  agentEnv.HIVEMIND_APP_DATA = ud;
  agentEnv.HIVEMIND_TILE = shell;
  agentEnv.HCP_TOKEN = tileToken(fs.readFileSync(path.join(ud, "hcp.token"), "utf8").trim(), `hm:${shell}`);
  agentQuery = new URL(agentEnv.AGENT_BROWSER_CDP!).search;
});
test.afterAll(async () => {
  await app?.close();
  a.close();
  b.close();
  fs.rmSync(ud, { recursive: true, force: true });
});
test.beforeEach(() => { posts.length = 0; });

test("what is saved keeps the password out of the file, and an agent lists a sign-in by name and site alone", async () => {
  await saveSignIn("site", `${good}/login`);
  expect(fs.readFileSync(path.join(ud, "browser-sign-ins.json"), "utf8")).not.toContain(PASSWORD);
  const listed = await agentRuns("sign-ins");
  expect(listed.json).toEqual({ signIns: [{ name: "site", site: good }] });
  expect(listed.out).not.toContain("me@example.com");
});

test("a no on the tile types nothing", async () => {
  await go(`${good}/in`);
  const run = agentRuns("sign-in", "site");
  await expect(askBar()).toContainText("wants to sign in to");
  await expect(askBar()).toContainText("me@example.com");
  await expect(askBar().getByRole("button", { name: "No" })).toBeEnabled();
  await press("No");
  const r = await run;
  expect(r.code).not.toBe(0);
  expect(r.json.outcome).toBe("no");
  expect(posts).toEqual([]);
  await expect(askBar()).toHaveCount(0);
});

test("on a yes the app signs in, and nothing an agent holding the page is told shows the password", async () => {
  await go(`${good}/in`);
  const agent = await holdThePage();
  const run = agentRuns("sign-in", "site");
  await expect(askBar().getByRole("button", { name: "Sign in once" })).toBeEnabled();
  await press("Sign in once");
  // Asked while the sign-in runs, this waits; asked of the field it would show the password.
  const asked = agent.send("Runtime.evaluate", { expression: "document.querySelector('[type=password]')?.value ?? ''", returnByValue: true }, agent.sessionId);
  const r = await run;
  expect(r.code).toBe(0);
  expect(r.json.outcome).toBe("sent");
  expect(posts).toEqual([{ site: "good", body: `email=me@example.com&password=${PASSWORD}` }]);
  expect(JSON.stringify((await asked).result)).not.toContain("real");

  await expect.poll(() => agent.heard.some((t) => t.includes('"Network.requestWillBeSent"') && t.includes("/session"))).toBe(true);
  const told = agent.heard.join("\n");
  expect(told).not.toContain("real");
  expect(told).not.toContain(encodeURIComponent(PASSWORD));
  expect(told).not.toContain(Buffer.from(PASSWORD).toString("base64"));
  const sent = agent.heard.map((t) => JSON.parse(t)).find((m) => m.method === "Network.requestWillBeSent" && m.params.request.url.endsWith("/session"));
  expect(sent.params.request.postData).toBeUndefined();
  expect((await agent.send("Network.getRequestPostData", { requestId: sent.params.requestId }, agent.sessionId)).error?.message).toContain("sign-in");
  agent.ws.close();
});

test("a page that says the password back does not say it to an agent", async () => {
  await saveSignIn("echoes", `${good}/echoes`);
  await go(`${good}/echoes`);
  const agent = await holdThePage();
  const run = agentRuns("sign-in", "echoes");
  await expect(askBar().getByRole("button", { name: "Sign in once" })).toBeEnabled();
  await press("Sign in once");
  expect((await run).json.outcome).toBe("sent");
  const title = await evaluate<string>("document.title");
  expect(title).toBe(PASSWORD);
  const told = await agent.send("Runtime.evaluate", { expression: "document.title", returnByValue: true }, agent.sessionId);
  expect(JSON.stringify(told.result)).toContain("••••••");
  expect(JSON.stringify(told.result)).not.toContain("real");
  agent.ws.close();
});

test("a form that asks for the username first is signed in over its two steps", async () => {
  await saveSignIn("two", `${good}/two`);
  await go(`${good}/two`);
  const run = agentRuns("sign-in", "two");
  await expect(askBar().getByRole("button", { name: "Sign in once" })).toBeEnabled();
  await press("Sign in once");
  expect((await run).json.outcome).toBe("sent");
  expect(posts[0]?.body).toContain(`password=${PASSWORD}`);
  expect(posts[0]?.body).toContain("email=me@example.com");
});

test("a sign-in whose address leads to another site types nothing there", async () => {
  await saveSignIn("away", `${good}/away`);
  await go(`${good}/in`);
  const run = agentRuns("sign-in", "away");
  await expect(askBar().getByRole("button", { name: "Sign in once" })).toBeEnabled();
  // The page goes elsewhere between the yes and the typing.
  await go(`${other}/login`);
  await press("Sign in once");
  const r = await run;
  expect(r.code).not.toBe(0);
  expect(r.json.outcome).toBe("person");
  expect(posts).toEqual([]);
  expect(await evaluate<string>("document.querySelector('[type=password]')?.value ?? ''")).toBe("");
});

test("a password field in a frame of the page is left alone", async () => {
  await saveSignIn("framed", `${good}/framed`);
  await go(`${good}/framed`);
  const run = agentRuns("sign-in", "framed");
  await expect(askBar().getByRole("button", { name: "Sign in once" })).toBeEnabled();
  await press("Sign in once");
  const r = await run;
  expect(r.json.outcome).toBe("person");
  expect(posts).toEqual([]);
});

test("a form still showing after the password is left for the person, with the password taken back out", async () => {
  await saveSignIn("stays", `${good}/stays`);
  await go(`${good}/stays`);
  const run = agentRuns("sign-in", "stays");
  await expect(askBar().getByRole("button", { name: "Sign in once" })).toBeEnabled();
  await press("Sign in once");
  const r = await run;
  expect(r.json.outcome).toBe("person");
  expect(String(r.json.why)).toContain("still showing");
  expect(await evaluate<string>("document.querySelector('[type=password]').value")).toBe("");
});

test("always on this site asks no more", async () => {
  await saveSignIn("always", `${good}/login`);
  await go(`${good}/in`);
  const first = agentRuns("sign-in", "always");
  await expect(askBar().getByRole("button", { name: "Always on this site" })).toBeEnabled();
  await press("Always on this site");
  expect((await first).json.outcome).toBe("sent");
  await go(`${good}/in`);
  posts.length = 0;
  expect((await agentRuns("sign-in", "always")).json.outcome).toBe("sent");
  expect(posts).toHaveLength(1);
});

test("an agent cannot answer its own question", async () => {
  await go(`${good}/in`);
  const run = agentRuns("sign-in", "site");
  await expect(askBar()).toBeVisible();
  const { asks } = (await agentRuns("asks")).json as { asks?: { ask: number }[] };
  const ask = asks?.[0]?.ask ?? (await page.evaluate(() => window.hive.browserAsks()))[0]!.ask;
  const answered = await agentRuns("answer", String(ask), "yes");
  expect(answered.code).not.toBe(0);
  expect(answered.out).toContain("the person's to answer");
  await expect(askBar()).toBeVisible();
  await expect(askBar().getByRole("button", { name: "No" })).toBeEnabled();
  await press("No");
  await run;
});

test("asked to sign in themselves, the person does it, and an agent holding the page sees none of it", async () => {
  await go(`${good}/login`);
  const agent = await holdThePage();
  const run = agentRuns("ask", "Please sign in");
  await expect(askBar()).toContainText("Please sign in");

  // The person types in the page and sends it.
  await evaluate("document.querySelector('[type=email]').focus()");
  await page.evaluate(async ([id, p]) => {
    await window.hive.browserWatch(id!);
    await window.hive.browserInput(id!, { kind: "text", text: "me@example.com" });
    await window.hive.browserCdp(id!, "Runtime.evaluate", { expression: "document.querySelector('[type=password]').focus()" });
    await window.hive.browserInput(id!, { kind: "text", text: p! });
    window.hive.browserUnwatch(id!);
  }, [tile, TYPED]);
  const asked = agent.send("Runtime.evaluate", { expression: "document.querySelector('[type=password]')?.value ?? ''", returnByValue: true }, agent.sessionId);
  await evaluate("document.querySelector('form').submit()");
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]!.body).toContain(TYPED);

  await expect(askBar().getByRole("button", { name: "Done" })).toBeEnabled();
  await press("Done");
  const r = await run;
  expect(r.code).toBe(0);
  expect(r.json.outcome).toBe("done");
  expect(JSON.stringify((await asked).result)).not.toContain("typed by");
  expect(agent.heard.join("\n")).not.toContain(encodeURIComponent(TYPED));
  agent.ws.close();
});
