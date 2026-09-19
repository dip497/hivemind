import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";

// Every `hive …` here is a fresh bun process (~0.4 s); the default 5 s is too tight.
setDefaultTimeout(60_000);
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { cmd, hive, hiveAsync, type Run } from "./helpers.js";
import { routeKeys } from "../src/commands/attach.js";
import { renderSessions } from "../src/commands/ps.js";
import type { SessionInfo } from "../src/pty-client.js";

const unix = process.platform !== "win32";
// sun_path is ~108 bytes; os.tmpdir() can be deep, /tmp is not.
const dir = unix ? fs.mkdtempSync("/tmp/hive-sess-") : "";
const sock = path.join(dir, "d.sock");
const env = { HIVEMIND_PTY_SOCK: sock, XDG_CONFIG_HOME: path.join(dir, "xdg") };
const run = (...args: string[]): Run => hive(args, { env });
const data = (r: Run) => (r.json as { data: Record<string, unknown> }).data;

beforeAll(() => { if (unix) expect(run("daemon", "start", "--json").code).toBe(0); });
afterAll(() => { if (unix) { run("daemon", "stop"); fs.rmSync(dir, { recursive: true, force: true }); } });

describe.skipIf(!unix)("daemon + sessions", () => {
  test("start is idempotent and status reports the daemon", () => {
    expect(data(run("daemon", "start", "--json"))).toMatchObject({ running: true, started: false });
    expect(data(run("daemon", "status", "--json"))).toMatchObject({ running: true, socket: sock });
  });

  test("run starts a persistent session that ps lists", () => {
    const r = run("run", "--id", "t-one", "--cwd", "/tmp", "--json", "--", "sh", "-c", "sleep 30");
    expect(r.code).toBe(0);
    expect(data(r)).toMatchObject({ id: "t-one" });
    const list = data(run("ps", "--json")).sessions as SessionInfo[];
    expect(list.find((s) => s.id === "t-one")).toMatchObject({ state: "live", cmd: "sh", cwd: "/tmp", viewers: 0 });
    expect(run("run", "--id", "t-one", "--", "true").json).toBeUndefined(); // human output, exit 1
    expect(run("run", "--id", "t-one", "--json", "--", "true").json).toMatchObject({ ok: false, code: "session_exists" });
  });

  const python = spawnSync("python3", ["--version"]).status === 0;
  test.skipIf(!python)("attach from a phone-sized tty: type, see output, own the size, detach", () => {
    expect(run("run", "--id", "t-attach", "--json", "--", "sh").code).toBe(0);
    const r = spawnSync("python3", [path.join(import.meta.dir, "fixtures", "pty-drive.py"), "45", "30", "1.5",
      "echo HI-$((6*7)); stty size\\r\\x00\\x02d", "--", ...cmd(["attach", "t-att"]).flat()], { env: { ...process.env, ...env }, encoding: "utf8", timeout: 40_000 });
    expect(r.stdout).toContain("HI-42");
    expect(r.stdout).toContain("30 45");
    expect(r.stdout).toContain("[detached from t-attach]");
    expect(r.stdout).toContain("<<exit 0>>");
    const after = (data(run("ps", "--json")).sessions as SessionInfo[]).find((x) => x.id === "t-attach");
    expect(after).toMatchObject({ state: "live", viewers: 0 });
  });

  test("kill ends a session by prefix; an unknown one is exit 5", () => {
    expect(run("run", "--id", "t-kill", "--json", "--", "sh", "-c", "sleep 60").code).toBe(0);
    expect(data(run("kill", "t-ki", "--json"))).toEqual({ id: "t-kill", killed: true });
    expect((data(run("ps", "--json")).sessions as SessionInfo[]).some((x) => x.id === "t-kill")).toBe(false);
    expect(run("kill", "nope").code).toBe(5);
  });

  test("attach never spawns: an unknown session is exit 5", () => {
    const r = run("attach", "nope");
    expect(r.code).toBe(5);
    expect(r.stderr).toContain("no session 'nope'");
  });

  test("run needs a command; bad ids are refused", () => {
    expect(run("run", "--json").code).toBe(2);
    expect(run("run", "--id", "a b", "--json", "--", "true").code).toBe(2);
  });

  test("a socket path too long for sun_path is refused up front", () => {
    const r = hive(["daemon", "start", "--json", "--socket", `/tmp/${"x".repeat(120)}.sock`], { env });
    expect(r.code).toBe(2);
    expect(r.json).toMatchObject({ code: "socket_invalid" });
  });
});

describe.skipIf(!unix)("hive push", () => {
  test("set, status, a real test push, off; only http(s) and known events", async () => {
    const got: { body: string; title?: string }[] = [];
    const srv = (await import("node:http")).createServer((req, res) => { let b = ""; req.on("data", (d) => { b += d; }); req.on("end", () => { got.push({ body: b, title: req.headers.title as string }); res.end(); }); });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(srv.address() as import("node:net").AddressInfo).port}/topic`;
    expect(data(run("push", "set", url, "--json"))).toEqual({ url, events: ["notification"] });
    expect(fs.statSync(path.join(dir, "push.json")).mode & 0o777).toBe(0o600);
    expect(data(run("push", "status", "--json"))).toMatchObject({ enabled: true, url });
    const sent = await hiveAsync(["push", "test", "--json"], { env });
    expect(sent.code).toBe(0);
    expect(got).toHaveLength(1);
    expect(got[0]!.body).toBe("test push from hivemind");
    expect(run("push", "set", "file:///etc/passwd", "--json").code).toBe(2);
    expect(run("push", "set", url, "--events", "everything", "--json").code).toBe(2);
    expect(data(run("push", "off", "--json"))).toEqual({ enabled: false });
    expect(run("push", "test", "--json").code).toBe(2);
    srv.close();
  });
});

describe("attach key routing (ctrl-b prefix)", () => {
  const b = (s: string) => Buffer.from(s, "binary");
  test("plain input passes through", () => expect(routeKeys(b("ls\r"), false)).toEqual({ send: b("ls\r"), detach: false, pending: false }));
  test("ctrl-b d detaches and drops what follows", () => expect(routeKeys(b("x\x02dy"), false)).toEqual({ send: b("x"), detach: true, pending: false }));
  test("ctrl-b ctrl-b sends one literal ctrl-b", () => expect(routeKeys(b("\x02\x02"), false).send).toEqual(b("\x02")));
  test("ctrl-b + other key passes both", () => expect(routeKeys(b("\x02c"), false).send).toEqual(b("\x02c")));
  test("a prefix split across reads still detaches", () => {
    const first = routeKeys(b("a\x02"), false);
    expect(first).toEqual({ send: b("a"), detach: false, pending: true });
    expect(routeKeys(b("d"), first.pending).detach).toBe(true);
  });
});

describe("ps rendering", () => {
  const s: SessionInfo = { id: "run-abc123", state: "live", cmd: "/usr/bin/claude", args: ["--resume"], cwd: "/srv/app", pid: 7, viewers: 2, cols: 120, rows: 40 };
  test("wide: a table", () => {
    const out = renderSessions([s], 120);
    expect(out.split("\n")[0]).toMatch(/^ID\s+STATE\s+VIEW\s+SIZE\s+WHAT/);
    expect(out).toContain("claude --resume");
  });
  test("control bytes in titles never reach the terminal", () => {
    const out = renderSessions([{ ...s, title: "evil\u001b]0;pwned\u0007\u009btitle" }], 120) + renderSessions([{ ...s, title: "x\u001b[2J" }], 40);
    // newlines separate rows; every other C0/C1 control byte must be gone
    expect(out).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
  });
  test("under 64 columns: compact cards that fit the width", () => {
    const out = renderSessions([s, { ...s, id: "x".repeat(80), state: "frozen", title: "fixing auth bug" }], 40);
    for (const line of out.split("\n")) expect(line.length).toBeLessThanOrEqual(40);
    expect(out).toContain("live·2");
    expect(out).toContain("fixing auth bug");
  });
});
