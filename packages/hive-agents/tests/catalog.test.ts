import { describe, expect, test } from "bun:test";
import { CATALOG, agentById, agentForCmd, identifyProvider, spawnableAgents, workerAgents, detectStatus } from "../src/index.js";
import { PROVIDERS, providerFor, NODE_PARTS, composeResume } from "../src/node.js";

describe("agent catalog", () => {
  test("ids and binaries are unique; every def declares every capability", () => {
    const ids = CATALOG.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    const bins = CATALOG.map((d) => d.bin);
    expect(new Set(bins).size).toBe(bins.length);
    for (const d of CATALOG) {
      expect(Object.keys(d.caps).sort()).toEqual(["blockedDetection", "modelFlag", "permissionModes", "promptDelivery", "resume", "supervise", "turnSignal"]);
      expect(typeof d.detect("")).toBe("string");
    }
  });
  test("spawn matching is exact-binary; identification also takes aliases", () => {
    expect(agentForCmd("/usr/local/bin/kiro-cli chat")?.id).toBe("kiro");
    expect(agentForCmd("kiro")).toBeUndefined(); // the Kiro IDE, a different product
    expect(identifyProvider("kiro")?.id).toBe("kiro");
    expect(identifyProvider("claude-code")?.id).toBe("claude");
    expect(agentForCmd("bash")).toBeUndefined();
  });
  test("spawnable vs worker sets follow the declared capabilities", () => {
    // Derived from the defs, so a provider added by its one catalog line is
    // covered without editing this test.
    expect(spawnableAgents().map((d) => d.id)).toEqual(CATALOG.filter((d) => d.enabled).map((d) => d.id));
    expect(workerAgents().map((d) => d.id)).toEqual(CATALOG.filter((d) => d.enabled && d.caps.turnSignal).map((d) => d.id));
    for (const id of ["claude", "droid", "pi", "kiro"]) expect(workerAgents().map((d) => d.id)).toContain(id);
    expect(workerAgents().map((d) => d.id)).not.toContain("codex");
    for (const d of CATALOG) if (!d.caps.turnSignal) expect(d.note).toBeTruthy();
  });
  test("drift guard: node halves and catalog defs agree", () => {
    const ids = new Set(CATALOG.map((d) => d.id));
    // Every node half belongs to a catalogued provider.
    for (const id of Object.keys(NODE_PARTS)) expect(ids.has(id), `NODE_PARTS["${id}"] has no catalog def`).toBe(true);
    // Every provider whose capabilities need injection/resume has a node half
    // (or says explicitly that it needs none).
    for (const d of CATALOG) {
      const needs = d.caps.resume !== "none" || d.caps.turnSignal;
      const has = !!NODE_PARTS[d.id]?.resume;
      if (needs && !d.noNodeHalf) expect(has, `${d.id} declares resume/turnSignal but has no node half`).toBe(true);
      if (!needs) expect(has, `${d.id} has a node half but declares neither resume nor a turn signal`).toBe(false);
    }
    expect(PROVIDERS.map((p) => p.id)).toEqual(CATALOG.filter((d) => NODE_PARTS[d.id]).map((d) => d.id));
    expect(providerFor("/opt/pi")?.id).toBe("pi");
    const r = composeResume({ execPath: "/x", trackerPath: "/x/t", tileSessionsDir: "/x/s" });
    expect(r.transformSpecOnSpawn({ cwd: "/", cmd: "bash", args: [], cols: 1, rows: 1 }, "t").args).toEqual([]);
  });
  test("detectStatus routes by id", () => {
    expect(detectStatus("pi", "Working...")).toBe("working");
    expect(detectStatus("claude", "x\n  1. No\n  2. Yes, allow")).toBe("permission");
    expect(detectStatus("nope", "anything")).toBe("idle");
    expect(agentById("droid")?.caps.turnSignal).toBe(true);
  });
});
