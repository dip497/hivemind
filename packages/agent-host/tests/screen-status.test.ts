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

test("the watcher reads only sessions with new output, reports changes, and finishes a held idle without new output", () => {
  let t = 0;
  const screens = new Map<string, string>([["a", "working"], ["s", "$ "]]);
  const reads: string[] = [];
  const reports: Array<[string, string]> = [];
  const w = new ScreenWatcher({
    read: (id) => { reads.push(id); const screen = screens.get(id); return screen === undefined ? undefined : { cmd: id === "s" ? "bash" : "agent", screen }; },
    detect: (cmd, screen) => (cmd === "bash" ? undefined : { status: screen === "working" ? "working" : "idle" }),
    report: (id, s) => reports.push([id, s.status]),
    now: () => t,
  });
  w.tick();
  expect(reads).toEqual([]);
  w.output("a"); w.output("s");
  w.tick();
  expect(reports).toEqual([["a", "working"]]);
  screens.set("a", "idle");
  w.output("a");
  t = 100; w.tick(); // held: still working, looked at again next tick
  expect(reports).toEqual([["a", "working"]]);
  t = 100 + SCREEN_WORKING_HOLD_MS + 1; w.tick(); // no new output, and the hold ends
  expect(reports).toEqual([["a", "working"], ["a", "idle"]]);
  screens.delete("a"); w.output("a"); w.tick();
  expect(reports.length).toBe(2);
});

test("a wait the screen says it is reports again when it says another, and saying nothing is no change", () => {
  const screens = new Map<string, ScreenReading>([["a", { status: "permission", says: "trust" }]]);
  const reports: ScreenReading[] = [];
  const w = new ScreenWatcher({
    read: (id) => ({ cmd: "agent", screen: id }),
    detect: (_cmd, screen) => screens.get(screen),
    report: (_id, r) => reports.push(r),
    now: () => 0,
  });
  w.output("a"); w.tick();
  screens.set("a", { status: "permission", says: "trust" }); w.output("a"); w.tick();
  screens.set("a", { status: "permission", says: "settings" }); w.output("a"); w.tick();
  screens.set("a", { status: "permission" }); w.output("a"); w.tick();
  expect(reports).toEqual([{ status: "permission", says: "trust" }, { status: "permission", says: "settings" }, { status: "permission" }]);
  expect(w.current()).toEqual([["a", { status: "permission" }]]);
});

test("each session's last line with text is reported as it changes, an agent's or any program's, cut to 160 characters", () => {
  const screens = new Map<string, { cmd: string; screen: string }>();
  const lines: string[] = [];
  const w = new ScreenWatcher({
    read: (id) => screens.get(id),
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
  w.tick();
  // A screen with no text yet says no line.
  expect(lines).toEqual(["t1: building", `t2: ● ${"x".repeat(158)}`]);
  screens.set("t1", { cmd: "bash", screen: "$ make\nbuilding\n" });
  w.output("t1");
  w.tick();
  expect(lines).toHaveLength(2);
  screens.set("t1", { cmd: "bash", screen: "$ make\nbuilding\ndone\n$ " });
  w.output("t1");
  w.tick();
  expect(lines.at(-1)).toBe("t1: $");
  w.forget("t1");
  screens.set("t1", { cmd: "bash", screen: "$" });
  w.output("t1");
  w.tick();
  // Forgotten, the same line is told again.
  expect(lines.at(-1)).toBe("t1: $");
  expect(lines).toHaveLength(4);
  expect(w.currentLines()).toEqual([["t2", `● ${"x".repeat(158)}`], ["t1", "$"]]);
});
