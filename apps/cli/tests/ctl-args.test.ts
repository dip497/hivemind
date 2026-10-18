import { describe, expect, test } from "bun:test";
import { READ_SLICE_MS, UsageError, boolFlag, durationFlag, emitArgs, intFlag, parseKeys, readSchedule, splitDouble, workflowPlan } from "../src/ctl-args.js";
import { EXIT, exitCodeFor } from "../src/hcp.js";
import { useFixtureAgents } from "./agents-fixtures.js";

// A workflow's agent must be in the catalog and drivable as a worker, as claude is.
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
  test("durationFlag takes units, and refuses a bare number that can only mean seconds", () => {
    expect(durationFlag(undefined, "timeout", 7)).toBe(7);
    expect(durationFlag("90s", "timeout", 7)).toBe(90_000);
    expect(durationFlag("5m", "timeout", 7)).toBe(300_000);
    expect(durationFlag("250ms", "timeout", 7)).toBe(250);
    expect(durationFlag("1500", "timeout", 7)).toBe(1500);
    expect(durationFlag("0", "timeout", 7)).toBe(0);
    expect(() => durationFlag("120", "timeout", 7)).toThrow(/120s/);
    expect(() => durationFlag("soon", "timeout", 7)).toThrow(UsageError);
  });
  test("boolFlag handles citty's true/false/undefined and strings", () => {
    expect(boolFlag(undefined)).toBeUndefined();
    expect(boolFlag(false)).toBe(false);
    expect(boolFlag("false")).toBe(false);
    expect(boolFlag("yes")).toBe(true);
  });
});

describe("workflowPlan", () => {
  const plan = (f: Parameters<typeof workflowPlan>[0]) => workflowPlan({ agent: "claude", ...f });
  test("fanout: its items and task, started as the agent named, ten minutes a turn, six at once", () => {
    expect(plan({ shape: "fanout", items: "x || y", prompt: "do {item}", close: true, supervise: "Bash, Edit" })).toEqual({
      shape: "fanout", items: ["x", "y"], prompt: "do {item}", stages: [], input: null, reducePrompt: "",
      program: "claude", supervise: ["Bash", "Edit"], turnMs: 600_000, concurrency: 6, close: true,
    });
  });
  test("pipeline needs stages, mapreduce a reducer's task; at least one and at most twelve at once", () => {
    expect(() => plan({ shape: "pipeline" })).toThrow(/stages/);
    expect(() => plan({ shape: "mapreduce", items: "a", prompt: "p" })).toThrow(/reduce-prompt/);
    expect(() => plan({ shape: "star" })).toThrow(/shape/);
    expect(plan({ shape: "pipeline", stages: "a || b", input: "seed", timeout: "1000" })).toMatchObject({ stages: ["a", "b"], input: "seed", turnMs: 1000 });
    expect(plan({ items: "a", prompt: "p", "max-concurrent": "40" }).concurrency).toBe(12);
    expect(plan({ items: "a", prompt: "p", "max-concurrent": "0" }).concurrency).toBe(1);
  });
});

describe("exit codes", () => {
  test("server codes map to stable exit statuses", () => {
    expect(exitCodeFor("BAD_REQUEST")).toBe(EXIT.usage);
    expect(exitCodeFor("UNAVAILABLE")).toBe(EXIT.unavailable);
    expect(exitCodeFor("TIMEOUT")).toBe(EXIT.timeout);
    expect(exitCodeFor("NOT_FOUND")).toBe(EXIT.notFound);
    expect(exitCodeFor("FORBIDDEN")).toBe(EXIT.unauthorized);
    expect(exitCodeFor("RATE_LIMITED")).toBe(EXIT.refused);
    expect(exitCodeFor("DEPTH_EXCEEDED")).toBe(EXIT.refused);
    expect(exitCodeFor("UNSUPPORTED")).toBe(EXIT.refused);
    expect(exitCodeFor("FAILED")).toBe(EXIT.error);
  });
});

describe("view emit arguments", () => {
  test("a dotted name and a JSON payload, or none", () => {
    expect(emitArgs("ci.build", '{"state":"failed"}', () => "")).toEqual({ name: "ci.build", data: { state: "failed" } });
    expect(emitArgs("deploy.done", undefined, () => "")).toEqual({ name: "deploy.done", data: null });
    expect(emitArgs("git.commit", "-", () => '{"sha":"abc123"}\n')).toEqual({ name: "git.commit", data: { sha: "abc123" } });
  });
  test("bad names, invalid JSON and oversized payloads are usage errors", () => {
    for (const [n, j] of [["CI", "{}"], ["hive.x", "{}"], ["ci.build", "{not json"], ["ci.build", JSON.stringify("x".repeat(5000))]] as const) {
      expect(() => emitArgs(n, j, () => "")).toThrow(UsageError);
    }
    expect(exitCodeFor("USAGE")).toBe(EXIT.usage);
  });
});
