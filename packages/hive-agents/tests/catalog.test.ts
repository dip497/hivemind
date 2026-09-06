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
    expect(spawnableAgents().map((d) => d.id)).toEqual(["claude", "codex", "opencode", "droid", "pi", "kiro"]);
    expect(workerAgents().map((d) => d.id)).toEqual(["claude", "droid", "pi", "kiro"]);
    for (const d of CATALOG) if (!d.caps.turnSignal) expect(d.note).toBeTruthy();
  });
  test("node parts exist exactly for providers that inject or resume", () => {
    expect(Object.keys(NODE_PARTS).sort()).toEqual(["claude", "codex", "droid", "kiro", "pi"]);
    for (const d of CATALOG) {
      const parts = NODE_PARTS[d.id];
      if (d.caps.resume === "none") expect(parts?.resume).toBeUndefined();
      else expect(parts?.resume).toBeDefined();
    }
    expect(PROVIDERS.map((p) => p.id)).toEqual(["claude", "codex", "droid", "kiro", "pi"]);
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
