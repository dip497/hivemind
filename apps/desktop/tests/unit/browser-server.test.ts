import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { serveBrowser } from "../../src/main/browser-server.ts";

const TOKEN = "t".repeat(43);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hm-browser-"));
const root = path.join(dir, "renderer");
fs.mkdirSync(path.join(root, "assets"), { recursive: true });
fs.writeFileSync(path.join(root, "browser.html"), "<!doctype html><div id=root></div>");
fs.writeFileSync(path.join(root, "assets", "app.js"), "console.log('app')");
fs.writeFileSync(path.join(dir, "secret.txt"), "not served");

const calls: Array<{ ch: string; args: unknown[] }> = [];
const server = await serveBrowser({
  port: 0,
  names: ["box.tail1234.ts.net"],
  token: TOKEN,
  root,
  page: "browser.html",
  platform: "linux",
  channels: {
    served: () => ["settings:get", "when", "echo:later", "workspace:notice"],
    invoke: (ch, tab, args) => {
      calls.push({ ch, args });
      if (ch === "when") return new Date(0);
      if (ch === "echo:later") setTimeout(() => tab.send("echoed", ...args), 5);
      return { ch, args };
    },
    send: (ch, _tab, args) => { calls.push({ ch, args }); },
  },
  onTab: () => {},
  onError: () => {},
});
after(() => server.close());

const here = `127.0.0.1:${server.port}`;
const cookie = `hive-${server.port}=${TOKEN}`;

function request(opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.port, method: opts.method ?? "GET", path: opts.path ?? "/", headers: { host: here, ...opts.headers } }, (res) => {
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end(opts.body);
  });
}

function socket(headers: Record<string, string>): Promise<{ ws: WebSocket; frames: unknown[]; closed: Promise<number> } | { refused: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${here}/socket`, { headers });
    const frames: unknown[] = [];
    const closed = new Promise<number>((done) => ws.on("close", (code) => done(code)));
    ws.on("message", (d) => frames.push(JSON.parse(String(d))));
    ws.on("unexpected-response", (_req, res) => resolve({ refused: res.statusCode! }));
    ws.on("error", () => {});
    ws.on("open", () => resolve({ ws, frames, closed }));
  });
}

const until = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
};

test("without the cookie every request is 401, and / is the page that signs in", { timeout: 10_000 }, async () => {
  const page = await request({ path: "/" });
  assert.equal(page.status, 401);
  assert.match(page.body, /\/session/);
  const asset = await request({ path: "/assets/app.js" });
  assert.equal(asset.status, 401);
  assert.doesNotMatch(asset.body, /console\.log/);
});

test("a Host that is not this machine's or a configured name is refused, cookie or not", { timeout: 10_000 }, async () => {
  assert.equal((await request({ headers: { host: `rebound.example:${server.port}`, cookie } })).status, 403);
  assert.equal((await request({ headers: { host: "box.tail1234.ts.net", cookie } })).status, 200);
  assert.equal((await request({ headers: { host: `localhost:${server.port}`, cookie } })).status, 200);
});

test("signing in takes this launch's token from this server's own page only", { timeout: 10_000 }, async () => {
  const post = (headers: Record<string, string>, body: string) => request({ method: "POST", path: "/session", headers, body });
  const foreign = await post({ origin: "http://evil.example" }, TOKEN);
  assert.equal(foreign.status, 403);
  assert.equal(foreign.headers["set-cookie"], undefined);
  assert.equal((await post({}, TOKEN)).status, 403);
  assert.equal((await post({ origin: `http://${here}` }, "x".repeat(43))).status, 401);

  const signed = await post({ origin: `http://${here}` }, TOKEN);
  assert.equal(signed.status, 204);
  const set = String(signed.headers["set-cookie"]);
  assert.match(set, new RegExp(`^hive-${server.port}=${TOKEN};`));
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
  assert.doesNotMatch(set, /Secure/);
  const behindTls = await post({ host: "box.tail1234.ts.net", origin: "https://box.tail1234.ts.net", "x-forwarded-proto": "https" }, TOKEN);
  assert.match(String(behindTls.headers["set-cookie"]), /; Secure/);
});

test("with the cookie the page and its files are served, and nothing outside them", { timeout: 10_000 }, async () => {
  const page = await request({ headers: { cookie } });
  assert.equal(page.status, 200);
  assert.match(page.body, /id=root/);
  assert.equal((await request({ path: "/assets/app.js", headers: { cookie } })).status, 200);
  const out = await request({ path: "/..%2fsecret.txt", headers: { cookie } });
  assert.equal(out.status, 404);
  assert.doesNotMatch(out.body, /not served/);
});

test("the socket needs the cookie, its own Origin, and this launch's token in its first frame", { timeout: 10_000 }, async () => {
  const origin = `http://${here}`;
  assert.deepEqual(await socket({ origin }), { refused: 403 });
  assert.deepEqual(await socket({ cookie, origin: "http://evil.example" }), { refused: 403 });
  assert.deepEqual(await socket({ cookie }), { refused: 403 });

  const leaked = await socket({ cookie, origin });
  assert.ok("ws" in leaked);
  leaked.ws.send(JSON.stringify({ t: "auth", token: "x".repeat(43) }));
  leaked.ws.send(JSON.stringify({ t: "invoke", id: 1, ch: "settings:get", args: [] }));
  assert.equal(await leaked.closed, 4401);
  assert.deepEqual(leaked.frames, []);
  assert.equal(calls.some((c) => c.ch === "settings:get"), false);
});

test("a signed-in tab calls the channels served, hears events, and nothing else", { timeout: 10_000 }, async () => {
  const tab = await socket({ cookie, origin: `http://${here}` });
  assert.ok("ws" in tab);
  tab.ws.send(JSON.stringify({ t: "auth", token: TOKEN }));
  tab.ws.send(JSON.stringify({ t: "invoke", id: 1, ch: "settings:get", args: ["a"] }));
  tab.ws.send(JSON.stringify({ t: "invoke", id: 2, ch: "pickProjectFolder", args: [] }));
  tab.ws.send(JSON.stringify({ t: "invoke", id: 3, ch: "when", args: [] }));
  tab.ws.send(JSON.stringify({ t: "invoke", id: 4, ch: "echo:later", args: ["hi"] }));
  tab.ws.send(JSON.stringify({ t: "send", ch: "workspace:notice", args: ["terminal.write", ["hm:a", "x"]] }));
  tab.ws.send(JSON.stringify({ t: "send", ch: "relaunchApp", args: [] }));
  await until(() => tab.frames.length >= 6);
  tab.ws.close();

  const [hello, ...rest] = tab.frames as Array<Record<string, unknown>>;
  assert.deepEqual(hello, { t: "hello", channels: ["settings:get", "when", "echo:later", "workspace:notice"], platform: "linux" });
  const result = (id: number) => rest.find((f) => f.t === "result" && f.id === id);
  assert.deepEqual(result(1), { t: "result", id: 1, value: { ch: "settings:get", args: ["a"] } });
  assert.match(String(result(2)?.error), /only in the app/);
  assert.match(String(result(3)?.error), /not JSON/);
  assert.deepEqual(rest.find((f) => f.t === "event"), { t: "event", ch: "echoed", args: ["hi"] });
  assert.equal(calls.some((c) => c.ch === "pickProjectFolder" || c.ch === "relaunchApp"), false);
  assert.deepEqual(calls.find((c) => c.ch === "workspace:notice")?.args, ["terminal.write", ["hm:a", "x"]]);
});

test("the server listens on 127.0.0.1 only", { timeout: 10_000 }, async () => {
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal);
  if (!lan) return;
  const reached = await new Promise<boolean>((resolve) => {
    const req = http.request({ host: lan.address, port: server.port, path: "/" }, () => resolve(true));
    req.on("error", () => resolve(false));
    req.end();
  });
  assert.equal(reached, false);
});

