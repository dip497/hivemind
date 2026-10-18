// Settings → API access and the drive socket: a program the person lets in from Settings drives the
// workspace in this window with the token shown there, is refused what its role does not reach,
// and is disconnected the moment the person takes it back.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

let root: string;
let app: ElectronApplication | undefined;
test.beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-drive-")); });
test.afterEach(async () => {
  await app?.close().catch(() => {});
  app = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

async function launch(): Promise<Page> {
  const config = path.join(root, "config");
  fs.mkdirSync(config, { recursive: true });
  execFileSync("git", ["init", "-q", path.join(root, "api")]);
  const env = { ...process.env, XDG_CONFIG_HOME: config, HIVE_SETTINGS: path.join(config, "settings.json") } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.resolve("out/main/index.js"), "--no-sandbox"], cwd: path.join(root, "api"), env });
  const page = await app.firstWindow();
  await page.waitForSelector(".react-flow");
  return page;
}

/** A program on the drive socket: what it is told, line by line, and a way to call. */
function program(sock: string, hello: object) {
  const socket = net.connect(sock);
  socket.setEncoding("utf8");
  const heard: Array<Record<string, unknown>> = [];
  let buf = "";
  socket.on("data", (chunk: string) => {
    buf += chunk;
    const lines = buf.split("\n");
    buf = lines.pop()!;
    for (const l of lines) heard.push(JSON.parse(l) as Record<string, unknown>);
  });
  const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
  socket.write(`${JSON.stringify({ hello })}\n`);
  let id = 0;
  const call = async (method: string, params: unknown[]) => {
    const mine = ++id;
    socket.write(`${JSON.stringify({ id: mine, method, params })}\n`);
    await expect.poll(() => heard.some((m) => m.id === mine)).toBe(true);
    return heard.find((m) => m.id === mine)!;
  };
  return { socket, heard, call, closed };
}

test("a program let in from Settings drives this workspace at its role, and is cut off when taken back", async () => {
  const page = await launch();
  const repo = path.join(root, "api");
  await page.getByLabel("settings", { exact: true }).click();
  await page.locator('[data-settings-page="api"]').click();
  await expect(page.locator("[data-grants-none]")).toBeVisible();

  await page.locator("[data-grant-name]").fill("orchestrator");
  await page.locator("[data-grant-create]").click();
  const token = (await page.locator("[data-grant-token] code").textContent())!.trim();
  await expect(page.locator("[data-grant]")).toContainText("orchestrator");
  await expect(page.locator("[data-grant]")).toContainText("Drive agents in api");

  const p = program(path.join(root, "config", "hivemind-dev", "drive.sock"), { token, workspace: repo });
  await expect.poll(() => p.heard[0]).toMatchObject({ hello: { api: expect.any(String), as: { client: "orchestrator", role: "agents", workspace: fs.realpathSync(repo) } } });
  const startable = await p.call("agent.startable", [fs.realpathSync(repo)]);
  expect(startable.result).toHaveProperty("programs");
  const pushed = await p.call("git.push", [fs.realpathSync(repo)]);
  expect((pushed.error as { code: string }).code).toBe("FORBIDDEN");

  await page.locator("[data-grant-revoke]").click();
  await p.closed;
  await expect(page.locator("[data-grants-none]")).toBeVisible();
  const again = program(path.join(root, "config", "hivemind-dev", "drive.sock"), { token, workspace: repo });
  await expect.poll(() => (again.heard[0]?.error as { code?: string } | undefined)?.code).toBe("FORBIDDEN");
  again.socket.destroy();
});

test("opened while `hive host` serves programs, Settings lets them in and takes them back there, and the host's service keeps running", async () => {
  const config = path.join(root, "config");
  const data = path.join(config, "hivemind-dev");
  const repo = path.join(root, "api");
  fs.mkdirSync(data, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  const env = {
    ...process.env, XDG_CONFIG_HOME: config, HIVE_SETTINGS: path.join(config, "settings.json"), HIVEMIND_APP_DATA: data,
    HIVEMIND_SHELL_ENV: "0", HIVEMIND_HIVE_NET: path.join(root, "none"), HCP_TOKEN: "", HIVEMIND_TILE: "", HIVE_DRIVE_SOCK: "", HIVE_HCP_SOCK: "",
  } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const cli = path.resolve("../cli/src/index.ts");
  const hive = (...args: string[]) => spawnSync("bun", [cli, ...args, "--json"], { env, encoding: "utf8" });
  // A tool plugin whose service only says hello, run by the host.
  const plugin = path.join(root, "hello");
  fs.mkdirSync(plugin);
  fs.writeFileSync(path.join(plugin, "hivemind-tool.json"), JSON.stringify({
    id: "acme/hello", name: "Hello", version: "1.0.0", apiVersion: 1, entry: "index.js",
    tools: [{ key: "hello", label: "Hello", tileKind: "acme-hello" }], service: { command: ["node", "service.js"], role: "view" },
  }));
  fs.writeFileSync(path.join(plugin, "index.js"), "export default { tiles: {} };\n");
  fs.writeFileSync(path.join(plugin, "service.js"), "process.stdin.on('end', () => process.exit(0)).resume(); console.log('up');\n");
  expect(hive("tools", "install", plugin).status).toBe(0);
  expect(hive("plugins", "enable", "tool:acme/hello").status).toBe(0);
  let host: ChildProcess | undefined;
  try {
    host = spawn("bun", [cli, "host", "run"], { env, stdio: "ignore" });
    await expect.poll(() => hive("host", "add", repo).status, { timeout: 30_000 }).toBe(0);
    expect(hive("plugins", "workspaces", "tool:acme/hello", repo).status).toBe(0);
    const log = () => { try { return fs.readFileSync(path.join(data, "services", "acme--hello.log"), "utf8"); } catch { return ""; } };
    await expect.poll(() => /started, pid (\d+)/.exec(log())?.[1], { timeout: 20_000 }).toBeTruthy();
    const service = Number(/started, pid (\d+)/.exec(log())![1]);
    const servicesGrants = () => (JSON.parse(hive("grant", "list").stdout).data as Array<{ plugin?: string }>).filter((g) => g.plugin === "acme/hello");
    expect(servicesGrants()).toHaveLength(1);

    app = await electron.launch({ args: [path.resolve("out/main/index.js"), "--no-sandbox"], cwd: repo, env });
    const page = await app.firstWindow();
    await page.waitForSelector(".react-flow");
    await page.getByLabel("settings", { exact: true }).click();
    await page.locator('[data-settings-page="api"]').click();
    await page.locator("[data-grant-name]").fill("orchestrator");
    await page.locator("[data-grant-create]").click();
    const token = (await page.locator("[data-grant-token] code").textContent())!.trim();

    const p = program(path.join(data, "drive.sock"), { token, workspace: repo });
    await expect.poll(() => p.heard[0]).toMatchObject({ hello: { as: { client: "orchestrator", role: "agents", workspace: fs.realpathSync(repo) } } });
    await page.locator('[data-grant]:has-text("orchestrator") [data-grant-revoke]').click();
    await p.closed;
    const again = program(path.join(data, "drive.sock"), { token, workspace: repo });
    await expect.poll(() => (again.heard[0]?.error as { code?: string } | undefined)?.code).toBe("FORBIDDEN");
    again.socket.destroy();

    expect(process.kill(service, 0)).toBe(true);
    expect(servicesGrants()).toHaveLength(1);
  } finally {
    await app?.close().catch(() => {});
    app = undefined;
    host?.kill("SIGTERM");
    if (host) await new Promise((r) => host!.once("exit", r));
    hive("daemon", "stop");
  }
});

test("a program opens a frame on a new worktree, and the window shows it in a place of its own", async () => {
  const page = await launch();
  const repo = fs.realpathSync(path.join(root, "api"));
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first"]);
  const person = program(path.join(root, "config", "hivemind-dev", "drive.sock"), { token: fs.readFileSync(path.join(root, "config", "hivemind-dev", "hcp.token"), "utf8").trim() });
  const { token } = (await person.call("grant.create", [{ name: "orchestrator", repos: [repo], role: "agents" }])).result as { token: string };
  person.socket.destroy();

  const p = program(path.join(root, "config", "hivemind-dev", "drive.sock"), { token, workspace: repo });
  const answer = await p.call("frame.open", [repo, { worktree: { branch: "fix-1" } }]);
  expect(answer.error).toBeUndefined();
  const opened = answer.result as { frame: string; path: string; opened: boolean };
  expect(opened.opened).toBe(true);
  expect(fs.existsSync(opened.path)).toBe(true);
  const frame = page.locator(`.react-flow__node-frame[data-id="${opened.frame}"]`);
  await expect(frame).toBeVisible();
  await expect(frame).toContainText("fix-1");
  const box = (await frame.boundingBox())!;
  expect(box.width).toBeGreaterThan(0);

  const again = (await p.call("frame.open", [repo, { worktree: { branch: "fix-1" } }])).result as { frame: string; opened: boolean };
  expect(again).toMatchObject({ frame: opened.frame, opened: false });
  const closed = (await p.call("frame.close", [repo, opened.frame, { removeWorktree: true }])).result as { worktreeRemoved: boolean };
  expect(closed.worktreeRemoved).toBe(true);
  await expect(frame).toHaveCount(0);
  expect(fs.existsSync(opened.path)).toBe(false);
  p.socket.destroy();
});
