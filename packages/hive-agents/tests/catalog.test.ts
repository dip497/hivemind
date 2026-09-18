import { afterEach, describe, expect, test } from "bun:test";
import { getCatalog, agentById, agentForCmd, identifyProvider, spawnableAgents, workerAgents, detectStatus, taskFromTitle, setCatalog } from "../src/index.js";
import { providers, providerFor, nodePartsFor, composeResume } from "../src/node.js";
import { authoredDefs } from "./authored.js";

// The published fixtures stand in for a machine that has installed every agent.
const CATALOG = authoredDefs();
setCatalog(CATALOG);
afterEach(() => setCatalog(CATALOG));

describe("agent catalog", () => {
  test("ids and binaries are unique; every def declares every capability", () => {
    const ids = getCatalog().map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    const bins = getCatalog().map((d) => d.bin);
    expect(new Set(bins).size).toBe(bins.length);
    for (const d of getCatalog()) {
      expect(Object.keys(d.caps).sort()).toEqual(["blockedDetection", "promptDelivery", "resume", "supervise", "turnSignal"]);
      if (d.detect) expect(typeof d.detect("")).toBe("string");
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
    expect(spawnableAgents().map((d) => d.id)).toEqual(getCatalog().filter((d) => d.enabled).map((d) => d.id));
    expect(workerAgents().map((d) => d.id)).toEqual(getCatalog().filter((d) => d.enabled && d.caps.turnSignal).map((d) => d.id));
    for (const id of ["claude", "droid", "pi", "kiro"]) expect(workerAgents().map((d) => d.id)).toContain(id);
    expect(workerAgents().map((d) => d.id)).not.toContain("codex");
    for (const d of getCatalog()) if (!d.caps.turnSignal) expect(d.note).toBeTruthy();
  });
  test("drift guard: what the daemon builds agrees with what each def declares", () => {
    for (const d of getCatalog()) {
      const needs = d.caps.resume !== "none" || d.caps.turnSignal;
      // Something has to deliver a claimed capability: the parts the manifest builds, or
      // the session store the manifest points at. Claiming one with neither is the drift
      // being guarded.
      const delivered = !!nodePartsFor(d)?.resume || !!d.session?.resume;
      if (needs) expect(delivered, `${d.id} declares resume/turnSignal but nothing delivers it`).toBe(true);
      else expect(delivered, `${d.id} delivers resume but declares neither resume nor a turn signal`).toBe(false);
    }
    expect(providers().map((p) => p.id)).toEqual(
      getCatalog().filter((d) => nodePartsFor(d) || d.session?.resume).map((d) => d.id));
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
  test("a window title names a tile only by the task its agent's templates find in it", () => {
    const pi = agentById("pi");
    expect(taskFromTitle(pi, "π - hivemind")).toBe("");
    expect(taskFromTitle(pi, "π - fix the login bug - hivemind")).toBe("fix the login bug");
    expect(taskFromTitle(agentById("claude"), "Claude Code")).toBe("");
    expect(taskFromTitle(agentById("claude"), "Fix the flaky test")).toBe("Fix the flaky test");
    expect(taskFromTitle(undefined, "a (b) [c] $d")).toBe("a (b) [c] $d");
  });
});
