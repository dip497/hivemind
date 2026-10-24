// The start-work guard from `hive` (design jira-sync §10): moving an issue into in_progress, or
// spawning an agent on it, refuses with exit 7 NEEDS_CONFIRM and every finding in `warnings` until
// the person's answer is given as a flag. With no app running the issue alone is checked; under
// `hive host` the agents on the board block a second start (even forced), and a tracker's tool
// service is what "--assign-me" goes through. Mirrored issues come in through `hive ingest`, shaped
// as the Jira service writes them (packages/jira-fake cloud-scrum-company).
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { cmd, hive, sealedEnv } from "./helpers.js";

setDefaultTimeout(150_000);
const unix = process.platform !== "win32";
// sun_path is ~108 bytes; os.tmpdir() can be deep, /tmp is not.
const dir = unix ? fs.realpathSync(fs.mkdtempSync("/tmp/hive-start-guard-")) : "";
const config = path.join(dir, "config");
const data = path.join(config, "hivemind");
const bin = path.join(dir, "bin");
const FAKE_AGENT = path.resolve(import.meta.dir, "../../desktop/tests/e2e/fixtures/fake-agent.cjs");
const DROID = path.resolve(import.meta.dir, "../../../packages/hive-agents/tests/fixtures/published-agents/droid");
const env = {
  XDG_CONFIG_HOME: config, HIVEMIND_APP_DATA: data, HIVEMIND_SHELL_ENV: "0", HIVEMIND_HIVE_NET: path.join(dir, "none"),
  PATH: `${bin}:${process.env.PATH}`, HIVE_HCP_SOCK: "", HIVE_DRIVE_SOCK: "", HCP_TOKEN: "", HIVEMIND_TILE: "", HIVEMIND_PTY_SOCK: "", HIVE_ACTOR: "tester",
};
const running: ChildProcess[] = [];
afterAll(() => {
  for (const c of running) c.kill("SIGKILL");
  if (unix) hive(["daemon", "stop"], { env });
  fs.rmSync(dir, { recursive: true, force: true });
});

const SOURCE = "jira:acme/PAY";
/** A record as the Jira service hands it to ingest. */
const record = (key: string, id: string, over: { assignee?: { name: string; me?: boolean } | null; status?: string; labels?: string[]; links?: unknown[] } = {}) => ({
  external: {
    id, key, url: `https://acme.atlassian.net/browse/${key}`, type: { id: "10001", name: "Story" }, remoteUpdated: "2026-10-22T09:14:00.000+0000",
    assignee: over.assignee === undefined ? null : over.assignee, sprint: { id: 87, name: "PAY Sprint 42", state: "active" },
    ...(over.links ? { links: over.links } : {}),
  },
  title: `Story ${key}`,
  status: over.status === "done" ? { id: "jira:10006", name: "Done", category: "done" } : { id: "jira:10001", name: "To Do", category: "todo" },
  labels: over.labels ?? [],
});
const git = (repo: string, ...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();

function workspace(name: string): string {
  const repo = path.join(dir, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "first");
  expect(hive(["init", "--prefix", "LOC", "--json"], { cwd: repo, env }).code).toBe(0);
  return repo;
}
const ingest = (repo: string, records: unknown[]) =>
  expect(hive(["ingest", "--source", SOURCE, "--json"], { cwd: repo, env, input: records.map((r) => JSON.stringify(r)).join("\n") }).code).toBe(0);
const show = (repo: string, id: string) => hive(["show", id, "--json"], { cwd: repo, env }).json as { state: string; branch?: string; external?: { assignee?: { me?: boolean } | null } };
type Refusal = { error: { code: string; message: string; fix?: string; warnings?: Array<{ check: string; severity: string; actions: string[] }> } };

describe.skipIf(!unix)("with no app running", () => {
  test("set-state and update into in_progress refuse with exit 7 until the person's answer is a flag; the issue is untouched meanwhile", () => {
    const repo = workspace("alone");
    ingest(repo, [record("PAY-318", "10423", { links: [{ type: "Blocks", direction: "inward", key: "PAY-321" }] }), record("PAY-325", "10430", { assignee: { name: "Jane Doe" }, labels: ["flagged"] })]);

    const refused = hive(["ctl", "set-state", "PAY-318", "in_progress", "--json"], { cwd: repo, env });
    expect(refused.code).toBe(7);
    const e = (refused.json as Refusal).error;
    expect(e.code).toBe("NEEDS_CONFIRM");
    expect(e.warnings!.map((w) => [w.check, w.severity])).toEqual([["unassigned", "warn"], ["blocked", "warn"]]);
    expect(e.fix).toContain("--ack unassigned --ack blocked");
    expect(e.fix).toContain("never --force on your own");
    expect(show(repo, "PAY-318").state).toBe("todo");

    // One answered, one left: still refused, naming the one left.
    const half = hive(["ctl", "set-state", "PAY-318", "in_progress", "--ack", "unassigned", "--json"], { cwd: repo, env });
    expect(half.code).toBe(7);
    expect((half.json as Refusal).error.warnings!.map((w) => w.check)).toEqual(["blocked"]);
    expect(hive(["ctl", "set-state", "PAY-318", "in_progress", "--ack", "unassigned,blocked", "--json"], { cwd: repo, env }).code).toBe(0);
    expect(show(repo, "PAY-318").state).toBe("in_progress");

    // hive update asks too, by --state or by a status in the in-progress category; --force answers every warning.
    expect(hive(["update", "PAY-325", "--state", "in_progress", "--json"], { cwd: repo, env }).code).toBe(7);
    expect(hive(["update", "PAY-325", "--state", "in_progress", "--force", "--json"], { cwd: repo, env }).code).toBe(0);
    expect(show(repo, "PAY-325").state).toBe("in_progress");

    // --assign-me goes through the tracker's service, which runs in the app or hive host: neither here.
    ingest(repo, [record("PAY-326", "10431")]);
    const noHost = hive(["ctl", "set-state", "PAY-326", "in_progress", "--assign-me", "--json"], { cwd: repo, env });
    expect(noHost.code).toBe(3);
    expect(show(repo, "PAY-326").state).toBe("todo");

    expect(hive(["ctl", "set-state", "PAY-326", "in_progress", "--ack", "unasigned", "--json"], { cwd: repo, env }).code).toBe(2);
  });

  test("a plain local issue starts as it always did", () => {
    const repo = workspace("plain");
    expect(hive(["new", "Plain work", "--json"], { cwd: repo, env }).code).toBe(0);
    expect(hive(["ctl", "set-state", "LOC-1", "in_progress", "--json"], { cwd: repo, env }).code).toBe(0);
  });
});

describe.skipIf(!unix)("under hive host", () => {
  test("spawn --issue: refused, then Assign to me through the tracker's service; the agent works in the issue's worktree; a second start is blocked even forced; workflow skips it", async () => {
    // A stand-in droid on PATH, and its manifest installed as the app installs one.
    fs.mkdirSync(bin, { recursive: true });
    const node = Bun.which("node") ?? process.execPath;
    fs.writeFileSync(path.join(bin, "droid"), `#!/usr/bin/env bash\nexec ${JSON.stringify(node)} ${JSON.stringify(FAKE_AGENT)} droid "$@"\n`, { mode: 0o755 });
    fs.cpSync(DROID, path.join(data, "agents", "droid"), { recursive: true });
    const [exe, pre] = cmd([]);
    fs.writeFileSync(path.join(bin, "hive"), `#!/usr/bin/env bash\nexec ${[Bun.which(exe) ?? exe, ...pre].map((a) => JSON.stringify(a)).join(" ")} "$@"\n`, { mode: 0o755 });

    const repo = workspace("hosted");
    ingest(repo, [record("PAY-318", "10423"), record("PAY-399", "10499")]);

    // The Jira plugin's part, as a tool service: it provides Assign to me for jira: issues, and
    // answers it by mirroring what Jira says now (the person assigned) through issue.ingest.
    const plugin = path.join(dir, "jira-plugin");
    fs.mkdirSync(plugin, { recursive: true });
    fs.writeFileSync(path.join(plugin, "hivemind-tool.json"), JSON.stringify({
      id: "@acme/jira", name: "Jira", version: "1.0.0", apiVersion: 1, entry: "index.js",
      tools: [{ key: "jira", label: "Jira", tileKind: "acme-jira" }],
      service: { command: ["node", "service.js"], role: "edit" },
    }));
    fs.writeFileSync(path.join(plugin, "index.js"), "export default { tiles: {} };\n");
    /** What Jira says once the person is assigned, by key. */
    const assigned = Object.fromEntries([["PAY-318", "10423"], ["PAY-399", "10499"]].map(([key, id]) => {
      const r = record(key!, id!, { assignee: { name: "Ujjwal Solanki", me: true } });
      r.external.remoteUpdated = "2026-10-23T09:14:00.000+0000";
      return [key, r];
    }));
    fs.writeFileSync(path.join(plugin, "service.js"), `
      const net = require("node:net");
      process.stdin.on("end", () => process.exit(0)).resume();
      const c = net.connect(process.env.HIVE_DRIVE_SOCK, () => c.write(JSON.stringify({ hello: { token: process.env.HIVE_DRIVE_TOKEN } }) + "\\n"));
      let n = 1000, buf = "";
      const pending = new Map();
      c.on("data", (d) => { buf += d; for (let i = buf.indexOf("\\n"); i >= 0; i = buf.indexOf("\\n")) { const l = buf.slice(0, i); buf = buf.slice(i + 1); const m = JSON.parse(l);
        if (m.hello) {
          c.write(JSON.stringify({ method: "plugin.serve", params: [[{ name: "assign-me", description: "assign in Jira" }]] }) + "\\n");
          c.write(JSON.stringify({ method: "issue.provideStart", params: [${JSON.stringify(path.join(repo, ".hivemind"))}, ${JSON.stringify(SOURCE)}, { assignMe: "assign-me" }] }) + "\\n");
          console.log("providing");
        } else if (m.event === "plugin.called") {
          const { call, args } = m.params[0];
          const id = n++;
          pending.set(id, call);
          c.write(JSON.stringify({ id, method: "issue.ingest", params: [args.root, ${JSON.stringify(SOURCE)}, [${JSON.stringify(assigned)}[args.id]]] }) + "\\n");
        } else if (m.id !== undefined && pending.has(m.id)) {
          c.write(JSON.stringify({ method: "plugin.answer", params: [pending.get(m.id), m.error ? { error: m.error } : { result: { assigned: true } }] }) + "\\n");
          pending.delete(m.id);
        }
      } });
      c.on("error", (e) => console.log("drive " + e.message));
    `);
    expect(hive(["plugins", "install", plugin, "--json"], { env }).code).toBe(0);
    expect(hive(["plugins", "enable", "tool:@acme/jira", "--json"], { env }).code).toBe(0);

    const host = spawn(...cmd(["host", "run"]), { env: { ...sealedEnv(), ...env }, stdio: "ignore" });
    running.push(host);
    const until = async <T>(get: () => T | null | undefined | false, what: string, ms = 30_000): Promise<T> => {
      for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) { const v = get(); if (v) return v; }
      throw new Error(`timed out waiting for ${what}; ${fs.existsSync(path.join(data, "services")) ? fs.readdirSync(path.join(data, "services")).join(",") : "no services dir"} ${log()}`);
    };
    await until(() => (hive(["host", "status", "--json"], { env }).json as { running?: boolean })?.running, "the host to answer");
    expect(hive(["host", "add", repo, "--json"], { env }).code).toBe(0);
    expect(hive(["plugins", "workspaces", "tool:@acme/jira", repo, "--json"], { env }).code).toBe(0);
    const log = () => { try { return fs.readFileSync(path.join(data, "services", "acme--jira.log"), "utf8"); } catch { return ""; } };
    await until(() => log().includes("providing"), "the Jira service to provide Assign to me");

    const ctl = (...args: string[]) => hive(["ctl", ...args, "--json"], { cwd: repo, env });
    const refused = ctl("spawn", "--issue", "PAY-318", "--agent", "droid");
    expect(refused.code, refused.stderr).toBe(7);
    expect((refused.json as Refusal).error.warnings).toEqual([expect.objectContaining({ check: "unassigned", actions: ["assign-me", "start", "cancel"] })]);
    expect(show(repo, "PAY-318").state).toBe("todo");

    const started = ctl("spawn", "--issue", "PAY-318", "--agent", "droid", "--assign-me");
    expect(started.code, started.stderr).toBe(0);
    const s = started.json as { started: true; tile: string; frame: string; branch: string; assigned: boolean };
    expect(s).toMatchObject({ started: true, branch: "PAY-318-story-pay-318", assigned: true });
    const issue = show(repo, "PAY-318");
    expect({ state: issue.state, branch: issue.branch, me: issue.external?.assignee?.me }).toEqual({ state: "in_progress", branch: "PAY-318-story-pay-318", me: true });
    const tiles = (ctl("tiles").json as { tiles: Array<{ tile: string; frame?: string }> }).tiles;
    expect(tiles.find((t) => t.tile === s.tile)?.frame).toBe(s.frame);
    const worktree = git(repo, "worktree", "list", "--porcelain");
    expect(worktree).toContain("branch refs/heads/PAY-318-story-pay-318");

    // An agent on it: forced or not, another start is refused, naming its tile.
    const again = ctl("spawn", "--issue", "PAY-318", "--agent", "droid", "--force");
    expect(again.code).toBe(7);
    expect((again.json as Refusal).error.warnings).toEqual([expect.objectContaining({ check: "agent-active", severity: "block" })]);
    expect((again.json as Refusal).error.message).toContain(s.tile);
    // A workflow over issues leaves it out, and says why.
    const wf = ctl("workflow", "--items", "PAY-318", "--prompt", "work on {item}", "--agent", "droid", "--force");
    expect(wf.code, wf.stderr).toBe(0);
    expect(wf.json).toMatchObject({ shape: "fanout", items: [], skipped: [{ item: "PAY-318", findings: [expect.objectContaining({ check: "agent-active" })] }] });

    // set-state --assign-me goes through the same service, then moves the issue.
    const viaState = ctl("set-state", "PAY-399", "in_progress", "--assign-me");
    expect(viaState.code, viaState.stderr).toBe(0);
    expect(show(repo, "PAY-399")).toMatchObject({ state: "in_progress", external: { assignee: { me: true } } });

    // frame add --worktree: the branch's worktree, made once and found again.
    const first = ctl("frame", "add", "--worktree", "spike", "--repo", repo).json as { frame: string; path: string; opened: boolean };
    expect(first.opened).toBe(true);
    expect(git(first.path, "branch", "--show-current")).toBe("spike");
    expect((ctl("frame", "add", "--worktree", "spike", "--repo", repo).json as { frame: string }).frame).toBe(first.frame);
  });
});
