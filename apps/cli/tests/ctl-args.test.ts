import { describe, expect, test } from "bun:test";
import { READ_SLICE_MS, UsageError, boolFlag, intFlag, parseKeys, readSchedule, splitDouble, tailLines, workflowParams } from "../src/ctl-args.js";
import { EXIT, exitCodeFor } from "../src/hcp.js";
import { useFixtureAgents } from "./agents-fixtures.js";

// workflowParams resolves the default agent from the catalog; a worker must be first,
// the way a machine whose default is claude looks.
useFixtureAgents(["claude"]);

describe("readSchedule", () => {
  test("--poll is one zero-length slice", () => expect(readSchedule(0)).toEqual([0]));
  test("splits a long wait into ≤10 s HCP requests, last one shortened", () => {
    expect(readSchedule(25_000)).toEqual([10_000, 10_000, 5_000]);
    expect(readSchedule(100_000).every((s) => s <= READ_SLICE_MS)).toBe(true);
    expect(readSchedule(100_000).reduce((a, b) => a + b, 0)).toBe(100_000);
  });
  test("short waits are a single slice", () => expect(readSchedule(3_000)).toEqual([3_000]));
});

describe("flag parsing", () => {
  test("splitDouble / parseKeys", () => {
    expect(splitDouble(" a || b ||c ")).toEqual(["a", "b", "c"]);
    expect(splitDouble(undefined)).toBeUndefined();
    expect(parseKeys("Down, Enter,,Esc")).toEqual(["Down", "Enter", "Esc"]);
  });
  test("intFlag defaults and rejects garbage with a usage error", () => {
    expect(intFlag(undefined, "timeout", 7)).toBe(7);
    expect(intFlag("1500", "timeout", 7)).toBe(1500);
    expect(() => intFlag("soon", "timeout", 7)).toThrow(UsageError);
    expect(() => intFlag("-1", "timeout", 7)).toThrow(UsageError);
  });
  test("boolFlag handles citty's true/false/undefined and strings", () => {
    expect(boolFlag(undefined)).toBeUndefined();
    expect(boolFlag(false)).toBe(false);
    expect(boolFlag("false")).toBe(false);
    expect(boolFlag("yes")).toBe(true);
  });
  test("tailLines keeps the last N lines", () => {
    expect(tailLines("a\nb\nc\n", 2)).toBe("b\nc\n");
    expect(tailLines("a\nb", 5)).toBe("a\nb");
    expect(tailLines("", 3)).toBe("");
  });
});

describe("workflowParams", () => {
  test("fanout → workflow.run params with the MCP field names", () => {
    const { params, ceilingMs } = workflowParams({ shape: "fanout", items: "x || y", prompt: "do {item}", close: true }, "tile-1");
    expect(params).toMatchObject({ shape: "fanout", items: ["x", "y"], prompt: "do {item}", agent: "claude", close_when_done: true, callerTile: "tile-1" });
    expect(params.timeout_ms).toBeUndefined();
    expect(ceilingMs).toBe(600_000 * 4 + 30_000);
  });
  test("pipeline needs stages; mapreduce needs reduce-prompt", () => {
    expect(() => workflowParams({ shape: "pipeline" })).toThrow(/stages/);
    expect(() => workflowParams({ shape: "mapreduce", items: "a", prompt: "p" })).toThrow(/reduce-prompt/);
    expect(() => workflowParams({ shape: "star" })).toThrow(/shape/);
    const { params } = workflowParams({ shape: "pipeline", stages: "a || b", input: "seed", timeout: "1000" });
    expect(params).toMatchObject({ stages: ["a", "b"], input: "seed", timeout_ms: 1000 });
  });
  test("ceiling is capped at 24h", () => {
    const { ceilingMs } = workflowParams({ shape: "fanout", items: "a", prompt: "p", timeout: String(10 * 60 * 60 * 1000) });
    expect(ceilingMs).toBe(24 * 60 * 60 * 1000);
  });
});

describe("exit codes", () => {
  test("server codes map to stable exit statuses", () => {
    expect(exitCodeFor("BAD_REQUEST")).toBe(EXIT.usage);
    expect(exitCodeFor("APP_NO_RENDERER")).toBe(EXIT.unavailable);
    expect(exitCodeFor("TIMEOUT")).toBe(EXIT.timeout);
    expect(exitCodeFor("TILE_NOT_FOUND")).toBe(EXIT.notFound);
    expect(exitCodeFor("UNAUTHORIZED")).toBe(EXIT.unauthorized);
    expect(exitCodeFor("RATE_LIMITED")).toBe(EXIT.refused);
    expect(exitCodeFor("INTERNAL")).toBe(EXIT.error);
  });
});
