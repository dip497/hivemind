import { expect, test } from "bun:test";
import type { ScreenReading } from "@hivemind/agents";
import { ScreenWatcher, SCREEN_WORKING_HOLD_MS, stabilizeScreenStatus } from "../src/screen-status.js";
import { SessionManager, type ManagedPty } from "../src/pty-session-manager.ts";

/** The cursor of a screen read for its status, which only the line looks at. */
const cursor = { row: 0, top: 0, hidden: true };

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
    read: async (ids) => new Map(ids.flatMap((id) => { reads.push(id); const screen = screens.get(id); return screen === undefined ? [] : [[id, { cmd: id === "s" ? "bash" : "agent", screen, cursor }] as const]; })),
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
    read: async (ids) => new Map(ids.map((id) => [id, { cmd: "agent", screen, cursor }])),
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
    read: async (ids) => new Map(ids.map((id) => [id, { cmd: "agent", screen: id, cursor }])),
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
  const screens = new Map<string, { cmd: string; screen: string; cursor: { row: number; top: number; hidden: boolean } }>();
  // The cursor shown on row `row`, in an input of that row alone, as the screen worker reads it.
  const at = (row: number) => ({ row, top: row, hidden: false });
  const lines: string[] = [];
  const w = new ScreenWatcher({
    read: async (ids) => new Map(ids.flatMap((id) => { const s = screens.get(id); return s ? [[id, s] as const] : []; })),
    detect: (cmd) => (cmd === "agent" ? { status: "working" } : undefined),
    report: () => {},
    line: (id, line) => lines.push(`${id}: ${line}`),
  });
  screens.set("t1", { cmd: "bash", screen: "$ make\nbuilding   \n\n  \n", cursor: at(2) });
  screens.set("t2", { cmd: "agent", screen: `● ${"x".repeat(200)}\n`, cursor: at(1) });
  screens.set("t3", { cmd: "bash", screen: "\n  \n", cursor: at(0) });
  w.output("t1");
  w.output("t2");
  w.output("t3");
  await w.tick();
  // A screen with no text yet says no line.
  expect(lines).toEqual(["t1: building", `t2: ● ${"x".repeat(158)}`]);
  screens.set("t1", { cmd: "bash", screen: "$ make\nbuilding\n", cursor: at(2) });
  w.output("t1");
  await w.tick();
  expect(lines).toHaveLength(2);
  // This was `$`: the prompt was the line, and every shell at rest said only that. The cursor waits
  // on the prompt, so the line is now what the command said before it (the rule's own tests, through
  // a real terminal, are below).
  screens.set("t1", { cmd: "bash", screen: "$ make\nbuilding\ndone\n$ ", cursor: at(3) });
  w.output("t1");
  await w.tick();
  expect(lines.at(-1)).toBe("t1: done");
  w.forget("t1");
  w.output("t1");
  await w.tick();
  // Forgotten, the same line is told again.
  expect(lines.at(-1)).toBe("t1: done");
  expect(lines).toHaveLength(4);
  expect(w.currentLines()).toEqual([["t2", `● ${"x".repeat(158)}`], ["t1", "done"]]);
});

/** A pty that says nothing of whose its terminal is, as the tests' fakes do, or says `holds`. */
function fakePty(holds?: boolean) {
  let emit: ((d: string) => void) | undefined;
  const pty: ManagedPty = {
    pid: 1234, write: () => {}, resize: () => {}, kill: () => {}, onData: (cb) => { emit = cb; }, onExit: () => {},
    ...(holds === undefined ? {} : { holdsTerminal: () => holds }),
  };
  return { pty, say: (d: string) => emit?.(d) };
}

/** `n` shells, t0 to t(n-1), whose lines a watcher reads as the daemon wires it: their output marks
 *  them for the next tick, and their screens are read by the real screen worker. `holds[i]`: whether
 *  shell i's own program holds its terminal, as Linux tells the daemon (left out: it is not told). */
async function shells(n: number, holds: Array<boolean | undefined> = []) {
  const said: Array<(d: string) => void> = [];
  const told: string[] = [];
  const w: ScreenWatcher = new ScreenWatcher({
    read: (ids) => m.viewports(ids),
    detect: () => undefined,
    report: () => {},
    line: (id, line) => told.push(`${id}: ${line}`),
  });
  const m = new SessionManager(() => { const f = fakePty(holds[said.length]); said.push(f.say); return f.pty; }, { onOutput: (id) => w.output(id) });
  for (let i = 0; i < n; i++) await m.createOrAttach(`t${i}`, { cwd: "/", cmd: "sh", args: [], cols: 80, rows: 24 }, { onData: () => {}, onExit: () => {} });
  return { w, told, say: (i: number, d: string) => said[i]!(d) };
}

test("the line is the last row with text above the input the cursor waits in, and not one drawn only of glyphs, without bidi controls; a command's question is the line", async () => {
  // What a shell printed, the line it says, and whether its own program holds the terminal.
  const cases: Array<[printed: string, line: string, holds?: boolean]> = [
    // A shell back at its prompt: the cursor waits on `$ `, so the line is what the command said.
    ["npm test\r\n214 tests passed\r\n$ ", "214 tests passed", true],
    // A prompt of two rows, which the shell marked (OSC 133 A): both are the prompt's.
    ["npm test\r\n214 tests passed\r\n\r\n\x1b]133;A\x07~/hivemind on  main via ⬢ v20\r\n❯ ", "214 tests passed", true],
    // A command typed past the width wraps onto a second row: both are the input's.
    [`done\r\n$ ${"x".repeat(100)}`, "done", true],
    // A command the shell ran holds the terminal and waits on its question, with the cursor on it.
    ["cp a b\r\nOverwrite b? [y/N] ", "Overwrite b? [y/N]", false],
    // Once the command typed at a marked prompt runs (OSC 133 C), what it prints is not the prompt's,
    // where whose the terminal is cannot be told too.
    ["\x1b]133;A\x07$ make\r\n\x1b]133;C\x07building\r\n", "building"],
    // A program that hid its cursor is not waiting for input on that row: what it wrote there is the line.
    ["\x1b[?25lDownloading 45%", "Downloading 45%"],
    // An agent's input box: its edges are drawn, and the cursor waits inside it.
    ["● Fixed the flaky test\r\n╭──────────╮\r\n│ >        │\r\n╰──────────╯\x1b[A\x1b[5G", "● Fixed the flaky test"],
    // An agent's input with its footer under it: the footer is the input's, not what the agent said.
    ["• Ran the tests: 214 passed\r\n\r\n› Ask Codex to do anything\r\n\r\n100% context left · ? for shortcuts\x1b[3;3H", "• Ran the tests: 214 passed", true],
    // A spinner is drawn, but what it says beside it is text.
    ["⠹ Running 214 tests\r\n", "⠹ Running 214 tests"],
    // An override would show the line reversed, as something it does not say.
    ["tests: \u202e3 failed\u202c, 10 passed\r\n", "tests: 3 failed, 10 passed"],
  ];
  const s = await shells(cases.length, cases.map(([, , holds]) => holds));
  cases.forEach(([printed], i) => s.say(i, printed));
  await s.w.tick();
  expect(s.told).toEqual(cases.map(([, line], i) => `t${i}: ${line}`));
});

test("a screen cleared tells a blank line once, and nothing is told while nothing new shows", async () => {
  const s = await shells(1);
  s.say(0, "npm test\r\n214 tests passed\r\n$ ");
  await s.w.tick();
  // Ctrl+L: the screen cleared, with only the prompt drawn again.
  s.say(0, "\x1b[H\x1b[2J$ ");
  await s.w.tick();
  expect(s.told).toEqual(["t0: 214 tests passed", "t0: "]);
  // No output, then output that leaves the screen as it was (a bell).
  await s.w.tick();
  s.say(0, "\x07");
  await s.w.tick();
  expect(s.told).toEqual(["t0: 214 tests passed", "t0: "]);
});
