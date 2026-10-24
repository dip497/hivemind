// The drive API's "done when" (docs/design/drive-api-2026-10-09.md), end to end in the app: a
// program holding a scoped grant, not the install's token, opens a frame on a new worktree, starts
// Claude there, sees it wait on Claude's folder-trust screen by name and answers it, reads its
// reply, its session and its conversation, answers a supervised tool use as the agent's
// supervisor, and is refused `git.push`. (HCP's fixed method list is held by hcp.test.ts.) Claude
// is the scripted stand-in (fixtures/fake-agent.cjs) behind the real claude manifest and wiring:
// its detect rules, --session-id, --settings hooks, the supervise broker.
import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedAgents } from "./helpers/agents";
import { stopDaemons } from "./helpers/daemons";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, "../..");
const CLI = path.resolve(APP_DIR, "../cli/src/index.ts");
const FIXTURE = path.join(__dirname, "fixtures", "fake-agent.cjs");
// Claude's folder-trust screen as 2.1.296 draws it in a folder it was never trusted in.
const TRUST_SCREEN = [
  " Accessing workspace:",
  "",
  " Quick safety check: Is this a project you created or one you trust?",
  "",
  " ❯ 1. Yes, I trust this folder",
  "   2. No, exit",
  "",
  " Enter to confirm · Esc to cancel",
].join("\n");

let root: string;
let app: ElectronApplication | undefined;
test.beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hm-drive-done-"))); });
test.afterEach(async () => {
  await app?.close();
  app = undefined;
  stopDaemons(root);
  fs.rmSync(root, { recursive: true, force: true });
});

function onPath(bin: string): string {
  for (const d of (process.env.PATH ?? "").split(":")) {
    const p = path.join(d, bin);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  throw new Error(`${bin} not on PATH`);
}

/** A program on the drive socket: what it is told, and a way to call. */
function program(sock: string, hello: object) {
  const socket = net.connect(sock);
  socket.setEncoding("utf8");
  const heard: Array<Record<string, unknown>> = [];
  let buf = "";
  socket.on("data", (chunk: string) => {
    buf += chunk;
    const lines = buf.split("\n");
    buf = lines.pop()!;
    for (const l of lines) {
      const m = JSON.parse(l) as Record<string, unknown> | Array<Record<string, unknown>>;
      heard.push(...(Array.isArray(m) ? m : [m]));
    }
  });
  socket.write(`${JSON.stringify({ hello })}\n`);
  let id = 0;
  const ask = async (method: string, params: unknown[]) => {
    const mine = ++id;
    socket.write(`${JSON.stringify({ id: mine, method, params })}\n`);
    await expect.poll(() => heard.some((m) => m.id === mine), { timeout: 60_000 }).toBe(true);
    return heard.find((m) => m.id === mine)! as { result?: unknown; error?: { code: string } };
  };
  const call = async (method: string, params: unknown[]) => {
    const answer = await ask(method, params);
    expect(answer.error, method).toBeUndefined();
    return answer.result as never;
  };
  return { socket, ask, call };
}

type Item = { tile: string; parent?: string; session?: string; waiting?: { kind: string; says?: string; since: number; approval?: { tool: string; summary: string } } };

test("a program with a scoped grant opens a worktree frame, starts Claude there, answers its trust screen by name, reads its reply, session and conversation, supervises it, and cannot push", async () => {
  test.setTimeout(150_000);
  const repo = path.join(root, "api");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first"]);
  const config = path.join(root, "config");
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const toolLog = path.join(root, "tools.log");
  for (const d of [config, home, bin]) fs.mkdirSync(d, { recursive: true });
  seedAgents(config);
  fs.writeFileSync(path.join(root, "trust-screen"), TRUST_SCREEN);
  fs.writeFileSync(path.join(bin, "claude"), `#!/usr/bin/env bash\nFAKE_GATE="$(cat ${JSON.stringify(path.join(root, "trust-screen"))})" FAKE_TOOL_LOG=${JSON.stringify(toolLog)} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FIXTURE)} claude "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "hive"), `#!/usr/bin/env bash\nexec ${JSON.stringify(onPath("bun"))} ${JSON.stringify(CLI)} "$@"\n`, { mode: 0o755 });
  const env = { ...process.env, XDG_CONFIG_HOME: config, HOME: home, PATH: `${bin}:${process.env.PATH}`, HIVEMIND_SHELL_ENV: "0" } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.join(APP_DIR, "out/main/index.js"), "--no-sandbox"], cwd: repo, env });
  const page = await app.firstWindow();
  await page.waitForSelector(".react-flow");

  const userData = path.join(config, "hivemind-dev");
  const sock = path.join(userData, "drive.sock");
  await expect.poll(() => fs.existsSync(sock)).toBe(true);
  // The person lets the program in; from here on it holds only its grant's token.
  const person = program(sock, { token: fs.readFileSync(path.join(userData, "hcp.token"), "utf8").trim() });
  const { grant, token } = await person.call("grant.create", [{ name: "orchestrator", repos: [repo], role: "agents" }]) as { grant: { id: string }; token: string };
  person.socket.destroy();
  const p = program(sock, { token, workspace: repo });

  // A frame on a new worktree, and Claude started in it.
  const opened = await p.call("frame.open", [repo, { worktree: { branch: "feature" } }]) as { frame: string; path: string };
  const { tile } = await p.call("agent.start", [repo, { program: "claude", frame: opened.frame, supervise: true }]) as { tile: string };
  const item = async (): Promise<Item | undefined> => ((await p.call("agent.list", [repo])) as { agents: Item[] }).agents.find((a) => a.tile === tile);

  // It waits on Claude's trust screen, by that name; the program answers it.
  await expect.poll(async () => (await item())?.waiting?.says, { timeout: 60_000 }).toBe("trust");
  const trust = (await item())!.waiting!;
  expect(trust.kind).toBe("permission");
  expect(await p.call("agent.answer", [tile, trust.since, { decision: "allow" }])).toMatchObject({ answered: true });
  await expect.poll(async () => (await item())?.waiting?.says ?? null, { timeout: 30_000 }).toBeNull();

  // Its reply, the session it is in, and its conversation in that session. Claude reports its
  // turns, so a message for it is held for its prompt from the start (#220) and typed once its
  // prompt reads empty (#223): sent, and held until then.
  expect(await p.call("agent.send", [tile, "echo hello from $PWD"])).toEqual({ sent: true, held: true });
  const reply = await p.call("agent.read", [tile, 60_000]) as { text: string; finalStatus: string };
  expect(reply).toMatchObject({ text: `hello from ${opened.path}`, finalStatus: "turn" });
  await expect.poll(async () => (await item())?.session, { timeout: 30_000 }).toBeTruthy();
  const session = (await item())!.session!;
  const conversation = await p.call("agent.conversation", [tile]) as { entries: Array<{ who: string; text?: string }>; session?: string };
  expect(conversation.session).toBe(session);
  expect(conversation.entries.map((e) => [e.who, e.text])).toEqual([["person", "echo hello from $PWD"], ["agent", `hello from ${opened.path}`]]);

  // A tool use it was started supervised for waits on the program, which answers it.
  expect(await p.call("agent.send", [tile, 'TOOL Bash {"command":"git push origin feature"}'])).toMatchObject({ sent: true });
  let asked: Item | undefined;
  await expect.poll(async () => { asked = await item(); return asked?.waiting?.kind; }, { timeout: 60_000 }).toBe("approval");
  expect(asked!.parent).toBe(`client:${grant.id}`);
  expect(asked!.waiting!.approval).toMatchObject({ tool: "Bash", summary: "git push origin feature" });
  expect(await p.call("agent.answer", [tile, asked!.waiting!.since, { decision: "deny" }])).toEqual({ answered: true });
  await expect.poll(() => (fs.existsSync(toolLog) ? fs.readFileSync(toolLog, "utf8") : ""), { timeout: 30_000 }).toMatch(/^Bash .*"permissionDecision":"deny"/m);

  // And it cannot push.
  expect((await p.ask("git.push", [repo])).error?.code).toBe("FORBIDDEN");
  p.socket.destroy();
});
