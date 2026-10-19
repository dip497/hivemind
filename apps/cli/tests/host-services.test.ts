// A tool plugin's service on a machine with no desktop: `hive host` runs it once the plugin is
// switched on and a workspace is picked with `hive plugins workspaces`, each read from the
// settings the app and `hive config` keep; the service drives that workspace as its own grant;
// switched off, it stops and its grant is taken back; it stops with the host, and starts with it
// again, nothing changed.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { cmd, hive, sealedEnv } from "./helpers.js";

setDefaultTimeout(60_000);
const unix = process.platform !== "win32";
// sun_path is ~108 bytes; os.tmpdir() can be deep, /tmp is not.
const dir = unix ? fs.realpathSync(fs.mkdtempSync("/tmp/hive-host-services-")) : "";
const config = path.join(dir, "config");
// The host's own data apart from the settings, as on a Mac, so it must read the shared ones.
const data = path.join(dir, "data");
const repo = path.join(dir, "repo");
const plugin = path.join(dir, "watcher");
const env = {
  XDG_CONFIG_HOME: config, HIVEMIND_APP_DATA: data, HIVEMIND_SHELL_ENV: "0", HIVEMIND_HIVE_NET: path.join(dir, "none"),
  HIVE_HCP_SOCK: "", HIVE_DRIVE_SOCK: "", HCP_TOKEN: "", HIVEMIND_TILE: "", HIVEMIND_PTY_SOCK: path.join(dir, "d.sock"),
};
const run = (...args: string[]) => hive([...args, "--json"], { env });
let host: ChildProcess | null = null;

async function until<T>(get: () => T | null | undefined | false, what: string, ms = 20_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) {
    const v = get();
    if (v) return v;
  }
  throw new Error(`timed out waiting for ${what}; log:\n${log()}`);
}
const log = () => { try { return fs.readFileSync(path.join(data, "services", "acme--watcher.log"), "utf8"); } catch { return ""; } };
const ours = () => ((run("grant", "list").json as { grants?: Array<{ plugin?: string; repos: string[]; role: string }> }).grants ?? []).filter((g) => g.plugin === "acme/watcher");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

afterAll(() => {
  host?.kill("SIGKILL");
  if (unix) hive(["daemon", "stop"], { env });
  fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!unix)("a tool plugin's service under hive host", () => {
  test("runs once switched on with a workspace picked, as its own grant there; stops when switched off, and with the host; starts with it again", async () => {
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(plugin, { recursive: true });
    fs.writeFileSync(path.join(plugin, "hivemind-tool.json"), JSON.stringify({
      id: "acme/watcher", name: "Watcher", version: "1.0.0", apiVersion: 1, entry: "index.js",
      tools: [{ key: "watch", label: "Watch", tileKind: "acme-watch" }],
      service: { command: ["node", "service.js"], role: "view" },
    }));
    fs.writeFileSync(path.join(plugin, "index.js"), "export default { tiles: {} };\n");
    fs.writeFileSync(path.join(plugin, "service.js"), `
      const net = require("node:net");
      process.stdin.on("end", () => process.exit(0)).resume();
      const c = net.connect(process.env.HIVE_DRIVE_SOCK, () => c.write(JSON.stringify({ hello: { token: process.env.HIVE_DRIVE_TOKEN } }) + "\\n"));
      c.on("data", (d) => { for (const l of String(d).split("\\n")) if (l.includes('"hello"')) console.log("hello " + JSON.stringify(JSON.parse(l).hello.as ?? JSON.parse(l))); });
      c.on("error", (e) => console.log("drive " + e.message));
    `);
    expect(run("tools", "install", plugin).code).toBe(0);
    expect(run("plugins", "enable", "tool:acme/watcher").code).toBe(0);
    expect(run("plugins", "workspaces", "tool:acme/watcher").json).toMatchObject({ workspaces: [] });

    host = spawn(...cmd(["host", "run"]), { env: { ...sealedEnv(), ...env }, stdio: "ignore" });
    await until(() => (run("host", "status").json as { running?: boolean })?.running, "the host to answer");
    expect(run("host", "add", repo).code).toBe(0);
    // Switched on with no workspace picked, it waits.
    await new Promise((r) => setTimeout(r, 2_500));
    expect(ours()).toEqual([]);

    const picked = run("plugins", "workspaces", "tool:acme/watcher", repo);
    expect(picked.json).toMatchObject({ workspaces: [repo] });
    await until(() => log().includes("hello "), "the service's hello");
    expect(log()).toContain(`hello ${JSON.stringify({ client: "Watcher service", role: "view", workspace: repo })}`);
    expect(ours()).toMatchObject([{ repos: [repo], role: "view" }]);
    const pid = Number(/started, pid (\d+)/.exec(log())![1]);

    expect(run("plugins", "disable", "tool:acme/watcher").code).toBe(0);
    await until(() => !alive(pid), "the service stopping when switched off");
    expect(ours()).toEqual([]);

    expect(run("plugins", "enable", "tool:acme/watcher").code).toBe(0);
    await until(() => (log().match(/started, pid/g) ?? []).length === 2, "the service starting again");
    const again = Number([...log().matchAll(/started, pid (\d+)/g)].at(-1)![1]);
    host.kill("SIGTERM");
    await until(() => !alive(again), "the service stopping with the host");
    expect(log()).toContain("stopping: the app stopped");
    await until(() => host!.exitCode !== null || host!.signalCode !== null, "the host to stop");

    host = spawn(...cmd(["host", "run"]), { env: { ...sealedEnv(), ...env }, stdio: "ignore" });
    await until(() => (log().match(/started, pid/g) ?? []).length === 3, "the service starting with the host");
  });
});
