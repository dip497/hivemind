import { expect, test } from "bun:test";
import type { ScreenReading } from "@hivemind/agents";
import { ScreenWatcher, SCREEN_WORKING_HOLD_MS, stabilizeScreenStatus } from "../src/screen-status.js";

test("a lone idle blip after working is held; a second idle past the window is the end", () => {
  const lw = { t: null as number | null };
  expect(stabilizeScreenStatus("idle", "working", 1000, lw)).toBe("working");
  expect(stabilizeScreenStatus("working", "idle", 1000 + SCREEN_WORKING_HOLD_MS - 1, lw)).toBe("working");
  expect(stabilizeScreenStatus("working", "idle", 1000 + SCREEN_WORKING_HOLD_MS + 1, lw)).toBe("idle");
  expect(stabilizeScreenStatus("working", "permission", 1000, lw)).toBe("permission");
});

test("the watcher reads only sessions with new output, reports changes, and finishes a held idle without new output", async () => {
  let t = 0;
  const screens = new Map<string, string>([["a", "working"], ["s", "$ "]]);
  const reads: string[] = [];
  const reports: Array<[string, string]> = [];
  const w = new ScreenWatcher({
    read: async (ids) => new Map(ids.flatMap((id) => { reads.push(id); const screen = screens.get(id); return screen === undefined ? [] : [[id, { cmd: id === "s" ? "bash" : "agent", screen }] as const]; })),
    detect: (cmd, screen) => (cmd === "bash" ? undefined : { status: screen === "working" ? "working" : "idle" }),
    report: (id, s) => reports.push([id, s.status]),
    now: () => t,
  });
  await w.tick();
  expect(reads).toEqual([]);
  w.output("a"); w.output("s");
  await w.tick();
  expect(reports).toEqual([["a", "working"]]);
  screens.set("a", "idle");
  w.output("a");
  t = 100; await w.tick(); // held: still working, looked at again next tick
  expect(reports).toEqual([["a", "working"]]);
  t = 100 + SCREEN_WORKING_HOLD_MS + 1; await w.tick(); // no new output, and the hold ends
  expect(reports).toEqual([["a", "working"], ["a", "idle"]]);
  screens.delete("a"); w.output("a"); await w.tick();
  expect(reports.length).toBe(2);
});

test("one idle frame between two of a chooser is not the wait's end, for any agent; idle that stays past the window is", async () => {
  let t = 0;
  let screen = "question";
  const reports: string[] = [];
  const w = new ScreenWatcher({
    read: async (ids) => new Map(ids.map((id) => [id, { cmd: "agent", screen }])),
    detect: (_cmd, s) => {
      const [status, says] = s.split(":");
      return { status: status as ScreenReading["status"], ...(says ? { says } : {}) };
    },
    report: (_id, r) => reports.push(r.says ? `${r.status}:${r.says}` : r.status),
    now: () => t,
  });
  w.output("a"); await w.tick();
  // A viewer's repaint cuts the chooser's footer for one frame.
  screen = "idle"; w.output("a"); t = 1_200; await w.tick();
  screen = "question"; w.output("a"); t = 2_400; await w.tick();
  expect(reports).toEqual(["question"]);
  // Answered at the desktop: its prompt stays, and the wait ends.
  screen = "idle"; w.output("a"); t = 3_600; await w.tick();
  expect(reports).toEqual(["question"]);
  t = 3_600 + SCREEN_WORKING_HOLD_MS + 1; await w.tick();
  expect(reports).toEqual(["question", "idle"]);
  // A wait held through the blip is still the screen it said it was.
  screen = "permission:trust"; w.output("a"); t = 10_000; await w.tick();
  screen = "idle"; w.output("a"); t = 11_200; await w.tick();
  screen = "permission:trust"; w.output("a"); t = 12_400; await w.tick();
  expect(reports).toEqual(["question", "idle", "permission:trust"]);
});

test("a wait the screen says it is reports again when it says another, and saying nothing is no change", async () => {
  const screens = new Map<string, ScreenReading>([["a", { status: "permission", says: "trust" }]]);
  const reports: ScreenReading[] = [];
  const w = new ScreenWatcher({
    read: async (ids) => new Map(ids.map((id) => [id, { cmd: "agent", screen: id }])),
    detect: (_cmd, screen) => screens.get(screen),
    report: (_id, r) => reports.push(r),
    now: () => 0,
  });
  w.output("a"); await w.tick();
  screens.set("a", { status: "permission", says: "trust" }); w.output("a"); await w.tick();
  screens.set("a", { status: "permission", says: "settings" }); w.output("a"); await w.tick();
  screens.set("a", { status: "permission" }); w.output("a"); await w.tick();
  expect(reports).toEqual([{ status: "permission", says: "trust" }, { status: "permission", says: "settings" }, { status: "permission" }]);
  expect(w.current()).toEqual([["a", { status: "permission" }]]);
});

test("each session's last line with text is reported as it changes, an agent's or any program's, cut to 160 characters", async () => {
  const screens = new Map<string, { cmd: string; screen: string }>();
  const lines: string[] = [];
  const w = new ScreenWatcher({
    read: async (ids) => new Map(ids.flatMap((id) => { const s = screens.get(id); return s ? [[id, s] as const] : []; })),
    detect: (cmd) => (cmd === "agent" ? { status: "working" } : undefined),
    report: () => {},
    line: (id, line) => lines.push(`${id}: ${line}`),
  });
  screens.set("t1", { cmd: "bash", screen: "$ make\nbuilding   \n\n  \n" });
  screens.set("t2", { cmd: "agent", screen: `● ${"x".repeat(200)}\n` });
  screens.set("t3", { cmd: "bash", screen: "\n  \n" });
  w.output("t1");
  w.output("t2");
  w.output("t3");
  await w.tick();
  // A screen with no text yet says no line.
  expect(lines).toEqual(["t1: building", `t2: ● ${"x".repeat(158)}`]);
  screens.set("t1", { cmd: "bash", screen: "$ make\nbuilding\n" });
  w.output("t1");
  await w.tick();
  expect(lines).toHaveLength(2);
  screens.set("t1", { cmd: "bash", screen: "$ make\nbuilding\ndone\n$ " });
  w.output("t1");
  await w.tick();
  expect(lines.at(-1)).toBe("t1: $");
  w.forget("t1");
  screens.set("t1", { cmd: "bash", screen: "$" });
  w.output("t1");
  await w.tick();
  // Forgotten, the same line is told again.
  expect(lines.at(-1)).toBe("t1: $");
  expect(lines).toHaveLength(4);
  expect(w.currentLines()).toEqual([["t2", `● ${"x".repeat(158)}`], ["t1", "$"]]);
});
