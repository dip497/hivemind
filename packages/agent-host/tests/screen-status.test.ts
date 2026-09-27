import { expect, test } from "bun:test";
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
    detect: (cmd, screen) => (cmd === "bash" ? undefined : screen === "working" ? "working" : "idle"),
    report: (id, s) => reports.push([id, s]),
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
