// What a session's starter does in an agent's first seconds, the window's and a host's alike: skip
// a startup screen its launch flags answered, and type its first task once its screen settles.
import { expect, test } from "bun:test";
import { AgentStart, DISMISS_MAX, DISMISS_WINDOW_MS, typeTask } from "../src/agent-start.ts";
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

test("a first task goes in after two quiet looks, or the eighth however busy, never while the screen waits", () => {
  const booting = new AgentStart(undefined, t0);
  expect(booting.settled(true, undefined)).toBe(false);
  expect(booting.settled(false, "idle")).toBe(false);
  expect(booting.settled(false, "idle")).toBe(true);
  // An agent that never goes quiet (a clock, a spinner) is not held for ever.
  const ticking = new AgentStart(undefined, t0);
  for (let i = 1; i < 8; i++) expect(ticking.settled(true, "working")).toBe(false);
  expect(ticking.settled(true, "working")).toBe(true);
  // A chooser or a question holds it however long it sits there: a task typed into it would pick
  // an option. Once it is answered, the agent has had long enough to boot.
  for (const status of ["question", "permission", "blocked"]) {
    const chooser = new AgentStart(undefined, t0);
    for (let i = 0; i < 12; i++) expect(chooser.settled(false, status)).toBe(false);
    expect(chooser.settled(false, "idle")).toBe(true);
  }
});

test("a typed task is pasted, Enter goes on its own, and once more only if the agent is still idle", async () => {
  const idle: Array<[string, boolean | undefined]> = [];
  const working: string[] = [];
  typeTask((data, paste) => idle.push([data, paste]), "fix the tests", () => true);
  typeTask((data) => working.push(data), "fix the tests", () => false);
  expect(idle).toEqual([["fix the tests", true]]);
  await wait(SUBMIT_DELAY_MS + 50);
  expect(idle).toEqual([["fix the tests", true], ["\r", undefined]]);
  await wait(SPAWN_SUBMIT_RETRY_MS);
  expect(idle).toEqual([["fix the tests", true], ["\r", undefined], ["\r", undefined]]);
  expect(working).toEqual(["fix the tests", "\r"]);
});
