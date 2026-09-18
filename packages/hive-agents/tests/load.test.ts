import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { agentAllowedIn, loadAgents, readAgentManifest, removeAgent, toWire, AGENT_MANIFEST_FILE } from "../src/load.js";
import { setCatalog, spawnArgsFor } from "../src/catalog.js";
import { defFromManifest, defsFromWire } from "../src/manifest.js";
import { prepareProviders, providers } from "../src/node.js";
import { AUTHORED, authoredYaml } from "./authored.js";

// A published agent, installed the way a machine that has it would have it: a folder
// under the user agents dir. Used wherever a test needs a second, real agent.
const published = (id: string): string => {
  const a = AUTHORED.find((x) => x.id === id);
  if (!a) throw new Error(`no published fixture "${id}"`);
  return authoredYaml(a);
};

const ACME = `manifestVersion: 1
id: acme
label: Acme Coder
bin: acme
aliases: [acme-cli]
enabled: true
caps:
  promptDelivery: typed
  turnSignal: false
  resume: none
  supervise: human
  blockedDetection: true
spawn:
  args: ["--no-color"]
  label: "acme #{n}"
  labelMode: " [{mode}]"
options:
  - { id: mode, label: Mode, flag: --mode, values: { plan: ["--dry-run"] } }
  - { id: model, label: Model, flag: -m }
detect:
  default: idle
  rules:
    - when: { contains: "approve this?" }
      then: blocked
    - when: { line: [{ gerundAfterPrefix: ["braille"] }] }
      then: working
`;

function userRoot(): string {
  const home = mkdtempSync(join(tmpdir(), "hm-agents-"));
  process.env.XDG_CONFIG_HOME = home;
  return join(home, "hivemind", "agents");
}

function install(root: string, id: string, yaml: string): void {
  mkdirSync(join(root, id), { recursive: true });
  writeFileSync(join(root, id, AGENT_MANIFEST_FILE), yaml);
}

describe("loading agents from disk", () => {
  test("a dropped-in folder becomes a spawnable provider", async () => {
    const root = userRoot();
    install(root, "acme", ACME);
    const { defs, loaded } = await loadAgents();

    const acme = defs.find((d) => d.id === "acme");
    expect(acme).toBeDefined();
    expect(acme!.label).toBe("Acme Coder");
    expect(acme!.enabled).toBe(true);
    expect(acme!.aliases).toEqual(["acme-cli"]);
    expect(spawnArgsFor(acme!, { mode: "plan" })).toEqual(["--no-color", "--dry-run"]);
    expect(spawnArgsFor(acme!, { mode: "acceptEdits", model: "big" }))
      .toEqual(["--no-color", "--mode", "acceptEdits", "-m", "big"]);
    expect(spawnArgsFor(acme!, {})).toEqual(["--no-color"]);
    expect(acme!.spawnLabel!(2, { mode: "plan" })).toBe("acme #2 [plan]");
    expect(acme!.spawnLabel!(2, {})).toBe("acme #2");
    // and its detector runs
    expect(acme!.detect!("nothing here")).toBe("idle");
    expect(acme!.detect!("APPROVE THIS?")).toBe("blocked");
    expect(acme!.detect!("⠋ Reading files…")).toBe("working");
    // an agent installed beside it loads with it
    install(root, "codex", published("codex"));
    expect((await loadAgents()).defs.find((d) => d.id === "codex")).toBeDefined();
    expect(loaded.every((a) => a.source === "user")).toBe(true);
  });

  test("a scoped folder is not an agent, and a scoped id cannot be removed", async () => {
    const root = userRoot();
    install(root, "@dip497/acme", ACME.replace("id: acme", "id: \"@dip497/acme\""));
    const { loaded } = await loadAgents();
    expect(loaded.find((a) => a.id.includes("acme"))?.def ?? null).toBeNull();
    for (const bad of ["@dip497/acme", "dip497/acme", "../acme"]) await expect(removeAgent(bad)).rejects.toThrow(/not an agent id/);
  });

  test("any provider can be switched off", async () => {
    const root = userRoot();
    install(root, "acme", ACME);
    install(root, "codex", published("codex"));
    const { defs, loaded } = await loadAgents({ disabled: ["codex", "acme"] });
    expect(defs.map((d) => d.id)).not.toContain("codex");
    expect(defs.map((d) => d.id)).not.toContain("acme");
    // disabled is reported, not hidden — the UI can still list and re-enable it
    expect(loaded.find((a) => a.id === "codex")!.disabled).toBe(true);
    expect(loaded.find((a) => a.id === "codex")!.error).toBeNull();
  });

  test("an agent a repository ships is tagged with that repository, and runs only inside it", async () => {
    const root = userRoot();
    install(root, "codex", published("codex"));
    const repoRoot = mkdtempSync(join(tmpdir(), "hm-repo-"));
    install(join(repoRoot, ".hivemind", "agents"), "fresh", ACME.replace("id: acme", "id: fresh").replace("bin: acme", "bin: fresh"));
    const { defs } = await loadAgents({ repoRoot });
    const fresh = defs.find((d) => d.id === "fresh")!;
    expect(fresh.sourceRoot).toBe(repoRoot);
    expect(agentAllowedIn(fresh, repoRoot)).toBe(true);
    expect(agentAllowedIn(fresh, join(repoRoot, "packages", "web"))).toBe(true);
    expect(agentAllowedIn(fresh, tmpdir())).toBe(false);
    expect(agentAllowedIn(fresh, `${repoRoot}-other`)).toBe(false);
    // A user agent belongs everywhere.
    expect(defs.find((d) => d.id === "codex")!.sourceRoot).toBeUndefined();
    expect(agentAllowedIn(defs.find((d) => d.id === "codex")!, tmpdir())).toBe(true);
  });

  test("a manifest cannot claim a root of its own", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "hm-repo-"));
    install(join(repoRoot, ".hivemind", "agents"), "sneaky",
      `${ACME.replace("id: acme", "id: sneaky").replace("bin: acme", "bin: sneaky")}sourceRoot: /\n`);
    const { defs } = await loadAgents({ repoRoot });
    expect(defs.find((d) => d.id === "sneaky")!.sourceRoot).toBe(repoRoot);
  });

  test("a repository cannot replace an agent you have — but can add new ones", async () => {
    const root = userRoot();
    install(root, "acme", ACME);
    const repoRoot = mkdtempSync(join(tmpdir(), "hm-repo-"));
    const agents = join(repoRoot, ".hivemind", "agents");
    install(agents, "acme", ACME.replace("Acme Coder", "Repo Acme"));
    install(agents, "claude", ACME.replace("id: acme", "id: claude").replace("bin: acme", "bin: sh"));
    install(agents, "fresh", ACME.replace("id: acme", "id: fresh").replace("bin: acme", "bin: fresh"));

    const { defs, loaded, shadowed } = await loadAgents({ repoRoot });
    expect(defs.find((d) => d.id === "acme")!.label).toBe("Acme Coder");
    expect(defs.find((d) => d.id === "fresh")).toBeDefined();
    expect(shadowed).toEqual([]);
    const refused = loaded.filter((a) => a.source === "repo" && a.error).map((a) => a.id).sort();
    expect(refused).toEqual(["acme", "claude"]);
    expect(loaded.find((a) => a.source === "repo" && a.id === "acme")!.error).toMatch(/would replace an agent you already have/);
    // `claude` is refused on the name too: the id is Hivemind's and it points at another command.
    expect(loaded.find((a) => a.source === "repo" && a.id === "claude")!.error).toMatch(/Hivemind's agent for `claude`/);
  });

  test("one broken plugin is reported and does not stop the others", async () => {
    const root = userRoot();
    install(root, "acme", ACME);
    install(root, "broken", "manifestVersion: 1\nid: broken\nlabel: [unclosed\n");
    install(root, "liar", ACME.replace("id: acme", "id: liar").replace("turnSignal: false", "turnSignal: true"));
    install(root, "mismatch", ACME); // dir "mismatch" vs id "acme"

    const { defs, loaded } = await loadAgents();
    expect(defs.find((d) => d.id === "acme")).toBeDefined();
    expect(defs.find((d) => d.id === "liar")).toBeUndefined();

    expect(loaded.find((a) => a.id === "broken")!.error).toBeTruthy();
    expect(loaded.find((a) => a.id === "liar")!.error).toMatch(/turnSignal must be false/);
    expect(loaded.find((a) => a.id === "mismatch")!.error).toMatch(/does not match manifest id/);
  });

  test("a missing plugin root is not an error", async () => {
    process.env.XDG_CONFIG_HOME = join(tmpdir(), "hm-does-not-exist-" + Date.now());
    const { defs, loaded } = await loadAgents();
    expect(loaded).toEqual([]);
    expect(defs).toEqual([]);
  });

  test("a published manifest keeps the capabilities it declares — no module of ours involved", async () => {
    const root = userRoot();
    install(root, "claude", published("claude"));
    const { defs } = await loadAgents();
    const claude = defs.find((d) => d.id === "claude")!;
    expect(claude.caps.turnSignal).toBe(true);
    expect(claude.caps.resume).toBe("tile");
    expect(claude.caps.supervise).toBe("broker");
  });

  test("a plugin cannot smuggle a reserved id's privileges", async () => {
    const root = userRoot();
    // The id is Hivemind's and it points at a different command: refused before
    // anything it claims is even read.
    install(root, "claude", ACME.replace("id: acme", "id: claude").replace("turnSignal: false", "turnSignal: true"));
    const { loaded, defs } = await loadAgents();
    expect(loaded.find((a) => a.source === "user" && a.id === "claude")!.error)
      .toMatch(/Hivemind's agent for `claude`/);
    expect(defs.find((d) => d.id === "claude")).toBeUndefined();
  });

  test("a manifest file that is not there reports why", async () => {
    const r = await readAgentManifest("/nope/agent.yaml", { source: "user" });
    expect(r.def).toBeNull();
    expect(r.error).toMatch(/cannot read agent.yaml/);
  });

  test("remove refuses anything that is not an agent id, so it cannot delete outside the agents folder", async () => {
    const root = userRoot();
    install(root, "acme", ACME);
    for (const bad of ["..", "", "../..", "acme/..", "."]) {
      await expect(removeAgent(bad)).rejects.toThrow(/not an agent id/);
    }
    expect(existsSync(join(root, "acme", AGENT_MANIFEST_FILE))).toBe(true);
    await removeAgent("acme");
    expect(existsSync(join(root, "acme"))).toBe(false);
  });
});

describe("what the loader hands the renderer", () => {
  test("a plugin's raw manifest is carried so it can cross IPC to the renderer", async () => {
    const root = userRoot();
    install(root, "acme", ACME);
    const { loaded } = await loadAgents();
    const acme = loaded.find((a) => a.id === "acme" && a.source === "user")!;
    expect(acme.manifest).toBeTruthy();
    // it must survive structuredClone — a def never could, it carries detect()
    const cloned = structuredClone(acme.manifest);
    expect(() => structuredClone(acme.def)).toThrow();
    // and rebuilding from the clone gives an equivalent def
    const rebuilt = defFromManifest(cloned);
    expect(rebuilt.id).toBe("acme");
    expect(rebuilt.detect!("APPROVE THIS?")).toBe("blocked");
    expect(spawnArgsFor(rebuilt, { mode: "plan" })).toEqual(["--no-color", "--dry-run"]);
  });

  test("a broken plugin still carries no manifest", async () => {
    const root = userRoot();
    install(root, "broken", "manifestVersion: 1\nid: broken\nlabel: [unclosed\n");
    const { loaded } = await loadAgents();
    const b = loaded.find((a) => a.id === "broken")!;
    expect(b.manifest).toBeNull();
    expect(b.error).toBeTruthy();
  });
});

describe("main → IPC → renderer round trip", () => {
  // The merge happens twice: main computes `defs` for its own process, and the
  // renderer rebuilds from manifests because a def cannot cross the boundary.
  // If those two ever disagree, the UI offers agents the daemon will not spawn.
  test("the renderer rebuilds exactly the catalog main computed", async () => {
    const root = userRoot();
    install(root, "acme", ACME);
    install(root, "beta", ACME.replace("id: acme", "id: beta").replace("bin: acme", "bin: beta").replace("Acme Coder", "Beta"));
    install(root, "broken", "manifestVersion: 1\nid: broken\nlabel: [unclosed\n");
    install(root, "codex", published("codex"));
    const repoRoot = mkdtempSync(join(tmpdir(), "hm-repo-"));
    install(join(repoRoot, ".hivemind", "agents"), "acme", ACME.replace("Acme Coder", "Repo Acme"));

    const { defs, loaded } = await loadAgents({ repoRoot, disabled: ["codex"] });

    // exactly what an ipcMain handler would return, through a real clone
    const wire = structuredClone(toWire(loaded));
    const rebuilt = defsFromWire(wire);

    expect(rebuilt.map((d) => d.id).sort()).toEqual(defs.map((d) => d.id).sort());
    expect(rebuilt.find((d) => d.id === "codex")).toBeUndefined();      // disabled
    expect(rebuilt.find((d) => d.id === "broken")).toBeUndefined();     // failed
    expect(rebuilt.find((d) => d.id === "acme")!.label).toBe("Acme Coder"); // the repo cannot replace it
    // and a plugin's behaviour survives the trip
    const acme = rebuilt.find((d) => d.id === "acme")!;
    expect(acme.detect!("APPROVE THIS?")).toBe("blocked");
    expect(spawnArgsFor(acme, { mode: "plan" })).toEqual(["--no-color", "--dry-run"]);
  });

  test("a disabled agent disappears on both sides", async () => {
    const root = userRoot();
    install(root, "codex", published("codex"));
    const { defs, loaded } = await loadAgents({ disabled: ["codex"] });
    const rebuilt = defsFromWire(structuredClone(toWire(loaded)));
    expect(defs.find((d) => d.id === "codex")).toBeUndefined();
    expect(rebuilt.find((d) => d.id === "codex")).toBeUndefined();
    expect(rebuilt.length).toBe(defs.length);
  });
});

describe("an installed agent gets the same daemon half as any other", () => {
  // The gap this closes: validation accepting `hooks`, `home` and `assets` from anyone
  // means nothing if the daemon only ever built the halves of agents that used to ship
  // in the box — an installed agent would declare them and have them silently never happen.
  const WORKER = `manifestVersion: 1
id: acme
label: Acme
bin: acme
caps:
  promptDelivery: typed
  turnSignal: true
  resume: none
  supervise: human
  blockedDetection: false
launch:
  hcp: true
  args: ["--settings", "{asset:settings.json}"]
assets:
  - { name: settings.json, file: settings.json }
`;

  test("its assets are written from the folder it was installed into, and it resumes", async () => {
    const root = userRoot();
    install(root, "acme", WORKER);
    // Constant for every tile, so it is written once when the daemon starts.
    writeFileSync(join(root, "acme", "settings.json"), '{"acme":true}');

    const { defs } = await loadAgents();
    setCatalog(defs);
    expect(providers().map((p) => p.id)).toContain("acme");

    const userData = mkdtempSync(join(tmpdir(), "hm-ud-"));
    const out = prepareProviders({
      userDataDir: userData,
      execPath: process.execPath,
      trackerPath: join(userData, "tracker.cjs"),
      tileSessionsDir: join(userData, "tile-sessions"),
      hcpSock: join(userData, "hcp.sock"),
    });
    const written = join(out.acme!.privateDir!, "settings.json");
    expect(existsSync(written), `${written} was never written`).toBe(true);
    expect(readFileSync(written, "utf8")).toBe('{"acme":true}');
    setCatalog([]);
  });
});
