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
// The published fixtures stand in for what auto-install from HiveHub puts on disk.
function installed(opts: { disabled?: string[] } = {}): { agents: Record<string, string>; disabled?: string[] } {
  const examples = path.join(import.meta.dir, "..", "..", "..", "packages", "hive-agents", "tests", "fixtures", "published-agents");
  const agents: Record<string, string> = {};
  for (const id of ["claude", "codex"]) {
    agents[id] = fs.readFileSync(path.join(examples, id, "agent.yaml"), "utf8");
  }
  return { agents, ...opts };
}
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
    const r = spawnAgent("codex", profile(installed({ disabled: ["codex"] })));
    expect(r.code).toBe(USAGE);
    expect(`${r.stdout}${r.stderr}`).toContain("--agent must be one of");
  });

  test("another installed agent is unaffected by one being switched off", () => {
    const r = spawnAgent("claude", profile(installed({ disabled: ["codex"] })));
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
    expect(rows.every((a) => a.source !== "builtin")).toBe(true); // nothing is compiled in

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

  test("an agent you did not install cannot be removed", () => {
    const r = hive(["agents", "remove", "claude", "--json"], { env: profile() });
    expect(r.code).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("no user-installed agent");
  });
});

describe("installing an agent that takes a reserved id", () => {
  const packageDir = (id: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hm-cli-pkg-"));
    tmp.push(dir);
    fs.writeFileSync(path.join(dir, "agent.yaml"), ACME.replace("id: acme", `id: ${id}`));
    return dir;
  };

  test("pointing a reserved id at another command is refused unless you say so", () => {
    const env = profile();
    const r = hive(["agents", "install", packageDir("claude"), "--json"], { env });
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toContain("Hivemind's agent for `claude`");
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

describe("validating an agent package before you publish it", () => {
  const pkg = (yaml: string, files: Record<string, string> = {}): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hm-cli-val-"));
    tmp.push(dir);
    fs.writeFileSync(path.join(dir, "agent.yaml"), yaml);
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
    return dir;
  };

  test("it answers with what a user will be told, not just pass or fail", () => {
    const r = hive(["agents", "validate", pkg(ACME), "--json"], { env: profile() });
    expect(r.code).toBe(0);
    expect(r.json.data).toMatchObject({ id: "acme", bin: "acme-coder", worker: false, does: [], warnings: [] });
  });

  test("an asset it names but does not ship is a warning, because it loads and then disappoints", () => {
    const withAsset = `${ACME}assets:\n- { name: hooks.json, file: hooks.json }\nlaunch:\n  env: { ACME_HOOKS: "{asset:hooks.json}" }\n`;
    expect(hive(["agents", "validate", pkg(withAsset), "--json"], { env: profile() }).json.data.warnings)
      .toEqual([expect.stringContaining("hooks.json is declared but not in this folder")]);
    expect(hive(["agents", "validate", pkg(withAsset, { "hooks.json": "{}" }), "--json"], { env: profile() }).json.data.warnings)
      .toEqual([]);
  });

  test("a name that is Hivemind's own is refused here, not after someone installs it", () => {
    const r = hive(["agents", "validate", pkg(ACME.replace("id: acme", "id: gemini")), "--json"], { env: profile() });
    expect(r.code).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("Hivemind's agent for `gemini`");
  });
});

describe("hive agents install <name>", () => {
  test("a bare name comes from the registry: shown first, installed with --yes, every file checked", () => {
    const reg = fs.mkdtempSync(path.join(os.tmpdir(), "hm-cli-registry-"));
    tmp.push(reg);
    fs.mkdirSync(path.join(reg, "agents", "acme"), { recursive: true });
    fs.writeFileSync(path.join(reg, "agents", "acme", "agent.yaml"), ACME);
    const sha = new Bun.CryptoHasher("sha256").update(ACME).digest("hex");
    fs.writeFileSync(path.join(reg, "index.json"), JSON.stringify({ version: 1, plugins: [{
      id: "acme", type: "agent", name: "Acme Coder", description: "d", author: "a", version: "1.0.0",
      path: "agents/acme", bin: "acme-coder", files: [{ path: "agent.yaml", sha256: sha }],
    }] }));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hm-cli-cwd-"));
    tmp.push(cwd);
    fs.mkdirSync(path.join(cwd, "acme")); // a same-named folder that is not an agent
    const env = { ...profile(), HIVEMIND_PLUGIN_INDEX: `file://${path.join(reg, "index.json")}` };
    let r = hive(["agents", "install", "acme", "--json"], { cwd, env });
    expect(r.json).toMatchObject({ ok: false, code: "install_unconfirmed" });
    expect((r.json as { error: string }).error).toContain("matches the hash HiveHub recorded");
    r = hive(["agents", "install", "acme", "--yes", "--json"], { cwd, env });
    expect(r.json).toMatchObject({ ok: true, data: { id: "acme" } });
    // A scope is a view's, never an agent's.
    r = hive(["agents", "install", "@dip497/acme", "--yes", "--json"], { cwd, env });
    expect(r.code).not.toBe(0);
  });
});
