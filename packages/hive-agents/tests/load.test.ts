import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { agentAllowedIn, loadAgents, readAgentManifest, removeAgent, toWire, AGENT_MANIFEST_FILE } from "../src/load.js";
import { BUILTIN_CATALOG, spawnArgsFor } from "../src/catalog.js";
import { defFromManifest, defsFromWire } from "../src/manifest.js";
import { NODE_PARTS } from "../src/node.js";

const BUILTIN = join(dirname(fileURLToPath(import.meta.url)), "..", "manifests");
const nodeHalf = (id: string): boolean => !!NODE_PARTS[id];

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
    const { defs, loaded } = await loadAgents({ builtinDir: BUILTIN, nodeHalf });

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
    // every built-in still loaded alongside it
    expect(loaded.filter((a) => a.source === "builtin" && !a.error).length).toBe(16);
  });

  test("any provider can be switched off, built-ins included", async () => {
    const root = userRoot();
    install(root, "acme", ACME);
    const { defs, loaded } = await loadAgents({
      builtinDir: BUILTIN, nodeHalf, disabled: ["claude", "acme"],
    });
    expect(defs.map((d) => d.id)).not.toContain("claude");
    expect(defs.map((d) => d.id)).not.toContain("acme");
    expect(defs.map((d) => d.id)).toContain("codex");
    // disabled is reported, not hidden — the UI can still list and re-enable it
    expect(loaded.find((a) => a.id === "claude")!.disabled).toBe(true);
    expect(loaded.find((a) => a.id === "claude")!.error).toBeNull();
  });

  test("an agent a repository ships is tagged with that repository, and runs only inside it", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "hm-repo-"));
    install(join(repoRoot, ".hivemind", "agents"), "fresh", ACME.replace("id: acme", "id: fresh").replace("bin: acme", "bin: fresh"));
    const { defs } = await loadAgents({ builtinDir: BUILTIN, repoRoot, nodeHalf });
    const fresh = defs.find((d) => d.id === "fresh")!;
    expect(fresh.sourceRoot).toBe(repoRoot);
    expect(agentAllowedIn(fresh, repoRoot)).toBe(true);
    expect(agentAllowedIn(fresh, join(repoRoot, "packages", "web"))).toBe(true);
    expect(agentAllowedIn(fresh, tmpdir())).toBe(false);
    expect(agentAllowedIn(fresh, `${repoRoot}-other`)).toBe(false);
    // Built-in and user agents belong everywhere.
    expect(defs.find((d) => d.id === "claude")!.sourceRoot).toBeUndefined();
    expect(agentAllowedIn(defs.find((d) => d.id === "claude")!, tmpdir())).toBe(true);
  });

  test("a manifest cannot claim a root of its own", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "hm-repo-"));
    install(join(repoRoot, ".hivemind", "agents"), "sneaky",
      `${ACME.replace("id: acme", "id: sneaky").replace("bin: acme", "bin: sneaky")}sourceRoot: /\n`);
    const { defs } = await loadAgents({ builtinDir: BUILTIN, repoRoot, nodeHalf });
    expect(defs.find((d) => d.id === "sneaky")!.sourceRoot).toBe(repoRoot);
  });

  test("a repository cannot replace an agent you have — built-in or your own — but can add new ones", async () => {
    const root = userRoot();
    install(root, "acme", ACME);
    const repoRoot = mkdtempSync(join(tmpdir(), "hm-repo-"));
    const agents = join(repoRoot, ".hivemind", "agents");
    install(agents, "acme", ACME.replace("Acme Coder", "Repo Acme"));
    install(agents, "claude", ACME.replace("id: acme", "id: claude").replace("bin: acme", "bin: sh"));
    install(agents, "fresh", ACME.replace("id: acme", "id: fresh").replace("bin: acme", "bin: fresh"));

    const { defs, loaded, shadowed } = await loadAgents({ builtinDir: BUILTIN, repoRoot, nodeHalf });
    expect(defs.find((d) => d.id === "acme")!.label).toBe("Acme Coder");
    expect(defs.find((d) => d.id === "claude")!.bin).toBe("claude");
    expect(defs.find((d) => d.id === "fresh")).toBeDefined();
    expect(shadowed).toEqual([]);
    const refused = loaded.filter((a) => a.source === "repo" && a.error).map((a) => a.id).sort();
    expect(refused).toEqual(["acme", "claude"]);
    expect(loaded.find((a) => a.source === "repo" && a.id === "claude")!.error).toMatch(/would replace an agent you already have/);
  });

  test("one broken plugin is reported and does not stop the others", async () => {
    const root = userRoot();
    install(root, "acme", ACME);
    install(root, "broken", "manifestVersion: 1\nid: broken\nlabel: [unclosed\n");
    install(root, "liar", ACME.replace("id: acme", "id: liar").replace("turnSignal: false", "turnSignal: true"));
    install(root, "mismatch", ACME); // dir "mismatch" vs id "acme"

    const { defs, loaded } = await loadAgents({ builtinDir: BUILTIN, nodeHalf });
    expect(defs.find((d) => d.id === "acme")).toBeDefined();
    expect(defs.find((d) => d.id === "liar")).toBeUndefined();

    expect(loaded.find((a) => a.id === "broken")!.error).toBeTruthy();
    expect(loaded.find((a) => a.id === "liar")!.error).toMatch(/turnSignal must be false/);
    expect(loaded.find((a) => a.id === "mismatch")!.error).toMatch(/does not match manifest id/);
    // 16 built-ins still fine
    expect(loaded.filter((a) => a.source === "builtin" && !a.error).length).toBe(16);
  });

  test("a missing plugin root is not an error", async () => {
    process.env.XDG_CONFIG_HOME = join(tmpdir(), "hm-does-not-exist-" + Date.now());
    const { defs, loaded } = await loadAgents({ builtinDir: BUILTIN, nodeHalf });
    expect(loaded.every((a) => !a.error)).toBe(true);
    expect(defs.length).toBe(16);
  });

  test("built-ins keep the capabilities their node halves back", async () => {
    process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "hm-empty-"));
    const { defs } = await loadAgents({ builtinDir: BUILTIN, nodeHalf });
    const claude = defs.find((d) => d.id === "claude")!;
    expect(claude.caps.turnSignal).toBe(true);
    expect(claude.caps.resume).toBe("tile");
    expect(claude.caps.supervise).toBe("broker");
    // …and one with no node half does not
    expect(defs.find((d) => d.id === "amp")!.caps.turnSignal).toBe(false);
  });

  test("a plugin cannot smuggle a built-in's privileges by reusing its id", async () => {
    const root = userRoot();
    // claude HAS a node half, but a user manifest is never trusted with it
    install(root, "claude", ACME.replace("id: acme", "id: claude").replace("turnSignal: false", "turnSignal: true"));
    const { loaded, defs } = await loadAgents({ builtinDir: BUILTIN, nodeHalf });
    expect(loaded.find((a) => a.source === "user" && a.id === "claude")!.error)
      .toMatch(/turnSignal must be false/);
    // the real built-in claude survives untouched
    expect(defs.find((d) => d.id === "claude")!.caps.turnSignal).toBe(true);
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

describe("compiled-in built-ins (how the app actually loads)", () => {
  test("builtins can be passed directly instead of read from disk", async () => {
    const root = userRoot();
    install(root, "acme", ACME);
    const { defs, loaded } = await loadAgents({ builtins: BUILTIN_CATALOG, nodeHalf });
    expect(defs.length).toBe(BUILTIN_CATALOG.length + 1);
    expect(defs.find((d) => d.id === "acme")).toBeDefined();
    // built-ins keep the caps their node halves back, without any YAML being read
    expect(defs.find((d) => d.id === "claude")!.caps.turnSignal).toBe(true);
    expect(loaded.filter((a) => a.source === "builtin").every((a) => a.file === "<compiled-in>")).toBe(true);
  });

  test("a plugin's raw manifest is carried so it can cross IPC to the renderer", async () => {
    const root = userRoot();
    install(root, "acme", ACME);
    const { loaded } = await loadAgents({ builtins: BUILTIN_CATALOG, nodeHalf });
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
    const { loaded } = await loadAgents({ builtins: BUILTIN_CATALOG, nodeHalf });
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
    const repoRoot = mkdtempSync(join(tmpdir(), "hm-repo-"));
    install(join(repoRoot, ".hivemind", "agents"), "acme", ACME.replace("Acme Coder", "Repo Acme"));

    const { defs, loaded } = await loadAgents({
      builtins: BUILTIN_CATALOG, repoRoot, disabled: ["codex"], nodeHalf,
    });

    // exactly what an ipcMain handler would return, through a real clone
    const wire = structuredClone(toWire(loaded));
    const rebuilt = defsFromWire(wire, BUILTIN_CATALOG);

    expect(rebuilt.map((d) => d.id).sort()).toEqual(defs.map((d) => d.id).sort());
    expect(rebuilt.find((d) => d.id === "codex")).toBeUndefined();      // disabled
    expect(rebuilt.find((d) => d.id === "broken")).toBeUndefined();     // failed
    expect(rebuilt.find((d) => d.id === "acme")!.label).toBe("Acme Coder"); // the repo cannot replace it
    // a built-in keeps the caps only its compiled node half can back
    expect(rebuilt.find((d) => d.id === "claude")!.caps.turnSignal).toBe(true);
    // and a plugin's behaviour survives the trip
    const acme = rebuilt.find((d) => d.id === "acme")!;
    expect(acme.detect!("APPROVE THIS?")).toBe("blocked");
    expect(spawnArgsFor(acme, { mode: "plan" })).toEqual(["--no-color", "--dry-run"]);
  });

  test("a disabled built-in disappears on both sides", async () => {
    process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "hm-empty-"));
    const { defs, loaded } = await loadAgents({ builtins: BUILTIN_CATALOG, disabled: ["claude"], nodeHalf });
    const rebuilt = defsFromWire(structuredClone(toWire(loaded)), BUILTIN_CATALOG);
    expect(defs.find((d) => d.id === "claude")).toBeUndefined();
    expect(rebuilt.find((d) => d.id === "claude")).toBeUndefined();
    expect(rebuilt.length).toBe(defs.length);
  });
});
