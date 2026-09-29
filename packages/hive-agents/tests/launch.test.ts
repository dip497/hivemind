// A new agent tile, as main's spawns and the window's make it (catalog.ts: nextOrdinal, agentLaunch).
import { afterEach, expect, test } from "bun:test";
import { agentById, agentLaunch, nextOrdinal, setCatalog } from "../src/index.js";
import type { SpawnOptions } from "../src/types.js";
import { authoredDefs } from "./authored.js";

const CATALOG = authoredDefs();
setCatalog(CATALOG);
afterEach(() => setCatalog(CATALOG));

test("a label's number is one past the highest in use, whatever else is there", () => {
  const f = (n: number) => `claude #${n}`;
  expect(nextOrdinal([], f)).toBe(1);
  expect(nextOrdinal(["claude #1", "shell #7", "claude #3 (plan)"], f)).toBe(4);
  expect(nextOrdinal(["Pi #2", "Pi #3"], (n) => `Pi #${n}`)).toBe(4);
});

test("a new agent tile runs the agent with the launch's options, continues a session where its manifest puts it, and takes the next free label and its prompt's task", () => {
  const claude = agentById("claude")!;
  expect(agentLaunch(claude, { options: { model: "opus" }, labels: [] })).toEqual({ cmd: "claude", args: ["--model", "opus"], label: "claude #1" });
  // A label that names the mode is counted with those that do not.
  const planned = { ...claude, spawnLabel: (n: number, o: SpawnOptions) => (o.mode === "plan" ? `claude #${n} (plan)` : `claude #${n}`) };
  expect(agentLaunch(planned, { options: { mode: "plan" }, labels: ["claude #1", "claude #3 (plan)", "shell #7"], prompt: "Review the auth module. Then fix it.", resume: "abc-123" }))
    .toEqual({ cmd: "claude", args: ["--resume", "abc-123", "--permission-mode", "plan"], label: "claude #4 (plan)", task: "Review the auth module" });
});
