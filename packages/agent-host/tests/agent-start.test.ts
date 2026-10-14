// What a session's starter does in an agent's first seconds, the window's and a host's alike: skip
// a startup screen its launch flags answered, and type its first task once its screen settles.
import { expect, test } from "bun:test";
import { AgentStart, DISMISS_MAX, DISMISS_WINDOW_MS } from "../src/agent-start.ts";
import { SPAWN_SUBMIT_RETRY_MS, SUBMIT_DELAY_MS } from "../src/agent-io.ts";

const hooksReview = { match: (s: string) => s.includes("hooks need review"), keys: ["Esc"] };
const t0 = 1_000_000;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a startup screen is skipped only at the start, only before the person types, only twice", () => {
  const start = new AgentStart({ dismiss: [hooksReview] }, t0);
  expect(start.dismiss("welcome", t0)).toBeNull();
  expect(start.dismiss("3 hooks need review", t0)).toEqual(["Esc"]);
  expect(start.dismiss("3 hooks need review", t0 + 1)).toEqual(["Esc"]);
  // A screen that keeps coming back is the agent's business, not ours.
  expect(DISMISS_MAX).toBe(2);
  expect(start.dismiss("3 hooks need review", t0 + 2)).toBeNull();
  expect(new AgentStart({ dismiss: [hooksReview] }, t0).dismiss("3 hooks need review", t0 + DISMISS_WINDOW_MS)).toBeNull();
  // Once the person has typed, the terminal is theirs: nothing is sent into it again.
  const theirs = new AgentStart({ dismiss: [hooksReview] }, t0);
  theirs.touch();
  expect(theirs.mayDismiss(t0)).toBe(false);
  expect(theirs.dismiss("3 hooks need review", t0)).toBeNull();
  // An agent whose manifest names no such screen, or a shell, is never read for one.
  expect(new AgentStart({}, t0).mayDismiss(t0)).toBe(false);
  expect(new AgentStart(undefined, t0).mayDismiss(t0)).toBe(false);
});

const prompt = "[hivemind] spawned claude (pid 1)\n\n❯ ";

test("a first task goes in after two quiet looks, or the eighth however busy, never while the screen waits", () => {
  const booting = new AgentStart(undefined, t0);
  expect(booting.settled(true, undefined, prompt)).toBe(false);
  expect(booting.settled(false, "idle", prompt)).toBe(false);
  expect(booting.settled(false, "idle", prompt)).toBe(true);
  // An agent that never goes quiet (a clock, a spinner) is not held for ever.
  const ticking = new AgentStart(undefined, t0);
  for (let i = 1; i < 8; i++) expect(ticking.settled(true, "working", prompt)).toBe(false);
  expect(ticking.settled(true, "working", prompt)).toBe(true);
  // A chooser or a question holds it however long it sits there: a task typed into it would pick
  // an option. Once it is answered, the agent has had long enough to boot.
  for (const status of ["question", "permission", "blocked"]) {
    const chooser = new AgentStart(undefined, t0);
    for (let i = 0; i < 12; i++) expect(chooser.settled(false, status, prompt)).toBe(false);
    expect(chooser.settled(false, "idle", prompt)).toBe(true);
  }
});

test("a quiet screen the agent has drawn nothing on is not its prompt: the task waits for it to draw", () => {
  const loading = new AgentStart(undefined, t0);
  for (let i = 0; i < 4; i++) expect(loading.settled(false, "idle", "[hivemind] spawned opencode (pid 1)\n\n")).toBe(false);
  expect(loading.settled(true, "idle", prompt)).toBe(false);
  expect(loading.settled(false, "idle", prompt)).toBe(false);
  expect(loading.settled(false, "idle", prompt)).toBe(true);
  // One that never draws still gets its task at the deadline.
  const blank = new AgentStart(undefined, t0);
  for (let i = 1; i < 8; i++) expect(blank.settled(false, "idle", "")).toBe(false);
  expect(blank.settled(false, "idle", "")).toBe(true);
});

/** What a look at the agent sees: its status, and a composer holding the task. */
const holding = (status: string | undefined, screen = "❯ fix the\n  tests") => async () => ({ status, screen });

test("a first task's Enter goes again at each look while the agent is idle, until its turn is seen, and never after", async () => {
  const typed: Array<[string, boolean | undefined]> = [];
  const seen: Array<string | undefined> = [undefined, "idle", "working", "idle", "idle"];
  new AgentStart(undefined, t0).typeTask((data, paste) => typed.push([data, paste]), "fix the tests", () => holding(seen.shift())());
  expect(typed).toEqual([["fix the tests", true]]);
  await wait(SUBMIT_DELAY_MS + 50);
  expect(typed.length).toBe(2);
  // Two dropped Enters, pressed again; then its turn runs, and nothing more goes into its prompt.
  await wait(SPAWN_SUBMIT_RETRY_MS * 5);
  expect(typed).toEqual([["fix the tests", true], ["\r", undefined], ["\r", undefined], ["\r", undefined]]);
}, 15_000);

test("a first task's Enter is not pressed again once the person types, nor while the agent waits on them", async () => {
  const theirs: string[] = [];
  const start = new AgentStart(undefined, t0);
  start.typeTask((data) => theirs.push(data), "fix the tests", holding("idle"));
  start.touch();
  const asking: string[] = [];
  new AgentStart(undefined, t0).typeTask((data) => asking.push(data), "fix the tests", holding("question"));
  await wait(SPAWN_SUBMIT_RETRY_MS * 2 + 100);
  expect(theirs).toEqual(["fix the tests", "\r"]);
  expect(asking).toEqual(["fix the tests", "\r"]);
}, 15_000);

test("a first task's Enter is not pressed again on a screen that no longer shows the task", async () => {
  // A trust chooser its status misreads as idle: an Enter there would pick its first option.
  const chooser = "Trust this folder?\n> 1. Trust this folder\n  2. Exit";
  const typed: string[] = [];
  new AgentStart(undefined, t0).typeTask((data) => typed.push(data), "fix the tests", holding("idle", chooser));
  await wait(SPAWN_SUBMIT_RETRY_MS * 2 + 100);
  expect(typed).toEqual(["fix the tests", "\r"]);
}, 15_000);
