// Exit 2 = --agent refused client-side; an accepted one fails later on HCP (no app running).
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hive } from "./helpers.js";

const ACME = `manifestVersion: 1
id: acme
label: Acme Coder
bin: acme-coder
enabled: true
caps:
  promptDelivery: typed
  turnSignal: false
  resume: none
  supervise: human
  blockedDetection: false
`;

const tmp: string[] = [];
afterAll(() => { for (const d of tmp) fs.rmSync(d, { recursive: true, force: true }); });

function profile(opts: { agents?: Record<string, string>; disabled?: string[] } = {}) {
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), "hm-cli-agents-"));
  tmp.push(xdg);
  for (const [id, yaml] of Object.entries(opts.agents ?? {})) {
    fs.mkdirSync(path.join(xdg, "hivemind", "agents", id), { recursive: true });
    fs.writeFileSync(path.join(xdg, "hivemind", "agents", id, "agent.yaml"), yaml);
  }
  if (opts.disabled) {
    fs.mkdirSync(path.join(xdg, "hivemind"), { recursive: true });
    fs.writeFileSync(path.join(xdg, "hivemind", "settings.json"),
      JSON.stringify({ v: 1, agents: { disabled: opts.disabled } }));
  }
  return {
    XDG_CONFIG_HOME: xdg,
    HIVE_SETTINGS: undefined,
    HIVE_HCP_SOCK: path.join(xdg, "no-such.sock"),
    HCP_TOKEN: "x",
  };
}

const USAGE = 2;
const spawnAgent = (agent: string, env: Record<string, string | undefined>) =>
  hive(["ctl", "spawn", "--agent", agent, "--json"], { env });

describe("the CLI reads the same agent list as the app", () => {
  test("an agent added from a manifest passes --agent validation", () => {
    const env = profile({ agents: { acme: ACME } });
    const r = spawnAgent("acme", env);
    expect(r.code).not.toBe(USAGE);
    expect(`${r.stdout}${r.stderr}`).not.toContain("--agent must be one of");
  });

  test("without the manifest, the same id is still refused", () => {
    const r = spawnAgent("acme", profile());
    expect(r.code).toBe(USAGE);
    expect(`${r.stdout}${r.stderr}`).toContain("--agent must be one of");
  });

  test("an agent switched off in Settings is refused by the CLI too", () => {
    const r = spawnAgent("codex", profile({ disabled: ["codex"] }));
    expect(r.code).toBe(USAGE);
    expect(`${r.stdout}${r.stderr}`).toContain("--agent must be one of");
  });

  test("the rest of the built-ins are unaffected by one being switched off", () => {
    const r = spawnAgent("claude", profile({ disabled: ["codex"] }));
    expect(r.code).not.toBe(USAGE);
  });
});

describe("hive agents", () => {
  test("install validates first, lists, and removes", () => {
    const env = profile();
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "hm-agent-src-"));
    tmp.push(src);
    fs.writeFileSync(path.join(src, "agent.yaml"), ACME);

    const inst = hive(["agents", "install", src, "--json"], { env });
    expect(inst.code).toBe(0);
    expect((inst.json as { data: { id: string } }).data.id).toBe("acme");

    const list = hive(["agents", "list", "--json"], { env });
    const rows = (list.json as { data: Array<{ id: string; source: string; error: string | null }> }).data;
    expect(rows.find((a) => a.id === "acme")).toMatchObject({ source: "user", error: null });
    expect(rows.find((a) => a.id === "claude")).toMatchObject({ source: "builtin" });

    const rm = hive(["agents", "remove", "acme", "--json"], { env });
    expect(rm.code).toBe(0);
    const after = (hive(["agents", "list", "--json"], { env }).json as { data: Array<{ id: string }> }).data;
    expect(after.find((a) => a.id === "acme")).toBeUndefined();
  });

  test("a broken manifest is refused BEFORE anything is copied", () => {
    const env = profile();
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "hm-agent-bad-"));
    tmp.push(src);
    fs.writeFileSync(path.join(src, "agent.yaml"), ACME.replace("turnSignal: false", "turnSignal: true"));
    const r = hive(["agents", "install", src, "--json"], { env });
    expect(r.code).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("turnSignal must be false");
    expect(fs.existsSync(path.join(env.XDG_CONFIG_HOME, "hivemind", "agents", "acme"))).toBe(false);
  });

  test("built-in agents cannot be removed, only switched off", () => {
    const r = hive(["agents", "remove", "claude", "--json"], { env: profile() });
    expect(r.code).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("switch them off instead");
  });
});

describe("installing an agent that would replace a built-in", () => {
  const packageDir = (id: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hm-cli-pkg-"));
    tmp.push(dir);
    fs.writeFileSync(path.join(dir, "agent.yaml"), ACME.replace("id: acme", `id: ${id}`));
    return dir;
  };

  test("is refused unless you say so, and the built-in is left alone", () => {
    const env = profile();
    const r = hive(["agents", "install", packageDir("claude"), "--json"], { env });
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toContain("install_refused");
    expect(fs.existsSync(path.join(env.XDG_CONFIG_HOME, "hivemind", "agents", "claude"))).toBe(false);
  });

  test("--replace installs it", () => {
    const env = profile();
    const r = hive(["agents", "install", packageDir("claude"), "--replace", "--json"], { env });
    expect(fs.existsSync(path.join(env.XDG_CONFIG_HOME, "hivemind", "agents", "claude", "agent.yaml"))).toBe(true);
    expect(r.code).toBe(0);
  });

  test("an id of its own still installs without the flag", () => {
    const env = profile();
    hive(["agents", "install", packageDir("acme2"), "--json"], { env });
    expect(fs.existsSync(path.join(env.XDG_CONFIG_HOME, "hivemind", "agents", "acme2", "agent.yaml"))).toBe(true);
  });
});
