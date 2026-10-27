import { expect, jest, test } from "bun:test";
import { StatusStore, SUBAGENT_GRACE_MS, isSessionStatus, type SessionStatus, type StatusChange } from "../src/status-store.js";

const store = () => { let t = 1000; const s = new StatusStore({ now: () => ++t }); return s; };

test("the screen stands in until the hooks speak; from then on only the hooks decide", () => {
  const s = store();
  s.screen("a", "working");
  expect(s.get("a")).toMatchObject({ state: "working", source: "screen" });
  s.event("a", { event: "turn.started" });
  s.event("a", { event: "turn.ended", outcome: "done" });
  s.screen("a", "working");
  expect(s.get("a")).toMatchObject({ state: "done", source: "hooks" });
  s.screen("b", "blocked");
  expect(s.get("b")).toMatchObject({ state: "waiting", kind: "other", source: "screen" });
});

test("a hook-reported turn showing the agent's own chooser is waiting, until the screen moves on or a hook speaks", () => {
  const s = store();
  s.event("a", { event: "turn.started" });
  s.screen("a", "idle"); // a gap between steps is not the end of a hooked turn
  expect(s.get("a")).toMatchObject({ state: "working", source: "hooks" });
  s.screen("a", "blocked"); // a model-switch prompt no hook reports
  expect(s.get("a")).toMatchObject({ state: "waiting", kind: "other", source: "hooks" });
  s.screen("a", "idle"); // answered, and the turn had already died on a limit: no Stop comes
  expect(s.get("a")).toMatchObject({ state: "idle", source: "hooks" });
  s.screen("a", "working"); // the override ended with the chooser
  expect(s.get("a")?.state).toBe("idle");
  s.event("a", { event: "turn.started" });
  s.screen("a", "blocked");
  s.event("a", { event: "turn.ended", outcome: "done" }); // a hook speaks: it decides again
  s.screen("a", "idle");
  expect(s.get("a")).toMatchObject({ state: "done", source: "hooks" });
});

test("a turn running before the hooks spoke here (the app started mid-turn) stays working when a hook from inside it comes first", () => {
  const s = store();
  s.screen("a", "working");
  s.event("a", { event: "input.resolved" }); // a tool use finished
  expect(s.get("a")).toMatchObject({ state: "working", source: "hooks" });
  s.event("a", { event: "turn.ended", outcome: "done" });
  expect(s.get("a")?.state).toBe("done");
  s.screen("b", "idle");
  s.event("b", { event: "input.resolved" });
  expect(s.get("b")?.state).toBe("idle");
});

test("what the screen read before the hooks spoke is dropped: a session start leaves it idle", () => {
  const s = store();
  s.screen("a", "working"); // a busy startup screen
  s.title("a", "Fix the tests");
  s.event("a", { event: "session.started" });
  expect(s.get("a")).toMatchObject({ state: "idle", source: "hooks", title: "Fix the tests" });
  s.screen("b", "blocked");
  s.event("b", { event: "turn.started" });
  expect(s.get("b")).toMatchObject({ state: "working", source: "hooks" });
  expect(s.get("b")!.kind).toBeUndefined();
});

test("a lone Esc or Ctrl+C during a hook-reported turn interrupts it; anything else does not", () => {
  const s = store();
  s.event("a", { event: "turn.started" });
  s.input("a", "\x1b[A");
  s.input("a", "hello");
  expect(s.get("a")!.state).toBe("working");
  s.input("a", "\x1b");
  expect(s.get("a")!.state).toBe("interrupted");
  s.event("a", { event: "turn.started" });
  s.input("a", "\x03");
  expect(s.get("a")!.state).toBe("interrupted");
  // A screen-read session is not second-guessed from keystrokes.
  s.screen("b", "working");
  s.input("b", "\x1b");
  expect(s.get("b")!.state).toBe("working");
});

test("Esc and Ctrl+C interrupt as kitty keys too, as Claude Code has the terminal send them; a key let go or another key does not", () => {
  const s = store();
  for (const key of ["\x1b[27u", "\x1b[99;5u", "\x1b[27;129u", "\x1b[99;69:1u"]) {
    s.event("a", { event: "turn.started" });
    s.input("a", key);
    expect(s.get("a")!.state, JSON.stringify(key)).toBe("interrupted");
  }
  s.event("a", { event: "turn.started" });
  for (const key of ["\x1b[27;1:3u", "\x1b[99u", "\x1b[27;5u", "\x1b[13u", "\x1b[99;5u\x1b[99;5u"]) s.input("a", key);
  expect(s.get("a")!.state).toBe("working");
});

test("answering the permission an agent waits on sets it working at once, not when the allowed tool finishes", () => {
  const s = store();
  s.event("a", { event: "turn.started" });
  s.event("a", { event: "input.requested", kind: "permission" });
  s.input("a", "\x1b[B"); // moving the selection answers nothing
  s.input("a", "y");
  expect(s.get("a")).toMatchObject({ state: "waiting", kind: "permission" });
  s.input("a", "1");
  expect(s.get("a")!.state).toBe("working");
  expect(s.get("a")!.kind).toBeUndefined();
  s.event("a", { event: "input.requested", kind: "permission" });
  s.input("a", "\r");
  expect(s.get("a")!.state).toBe("working");
  // A question is answered with text: its keys are not an answer until the agent says so.
  s.event("a", { event: "input.requested", kind: "question" });
  s.input("a", "1");
  expect(s.get("a")).toMatchObject({ state: "waiting", kind: "question" });
});

test("a wait the hooks reported ends when the screen moves from the chooser to the agent's prompt, however it was left", () => {
  const s = store();
  s.event("a", { event: "turn.started" });
  s.screen("a", "working");
  s.event("a", { event: "input.requested", kind: "permission" });
  s.screen("a", "idle"); // its prompt, before its chooser is drawn, ends nothing
  expect(s.get("a")).toMatchObject({ state: "waiting", kind: "permission" });
  s.screen("a", "question"); // a question tool: its hook says permission, its screen a question
  expect(s.get("a")).toMatchObject({ state: "waiting", kind: "permission" });
  s.screen("a", "idle"); // left by keys no rule reads, or anything else no hook reports
  expect(s.get("a")).toMatchObject({ state: "idle", source: "hooks" });
  expect(s.get("a")!.kind).toBeUndefined();
  // Its chooser read before its hook spoke is the wait it shows.
  s.event("a", { event: "turn.started" });
  s.screen("a", "permission");
  s.event("a", { event: "input.requested", kind: "permission" });
  s.screen("a", "idle");
  expect(s.get("a")).toMatchObject({ state: "idle", source: "hooks" });
  // Answered with a key it reads, it works: the prompt before the tool runs is no end of the turn.
  s.event("a", { event: "turn.started" });
  s.event("a", { event: "input.requested", kind: "permission" });
  s.screen("a", "permission");
  s.input("a", "1");
  s.screen("a", "idle");
  expect(s.get("a")!.state).toBe("working");
});

test("exit is final whatever the source says next", () => {
  const s = store();
  s.screen("a", "working");
  s.exited("a");
  s.screen("a", "working");
  s.event("a", { event: "turn.started" });
  expect(s.get("a")!.state).toBe("exited");
});

test("each change is told once, numbered in order; a report that changes nothing is not told", () => {
  const s = store();
  const seen: StatusChange[] = [];
  s.subscribe((c) => seen.push(c));
  s.event("a", { event: "turn.started" });
  s.event("a", { event: "turn.started" }); // no change, no entry
  s.event("a", { event: "subagent.started", agentId: "x" });
  expect(seen.map((c) => c.seq)).toEqual([1, 2]);
});

test("since moves only when the state changes", () => {
  const s = store();
  s.event("a", { event: "turn.started" });
  const since = s.get("a")!.since;
  s.event("a", { event: "subagent.started", agentId: "x" });
  expect(s.get("a")!.since).toBe(since);
  s.event("a", { event: "turn.ended" });
  expect(s.get("a")!.since).toBeGreaterThan(since);
});

test("waiting on something else is a new wait: since moves, so an answer to the first is not taken for the second", () => {
  const s = store();
  s.event("a", { event: "input.requested", kind: "permission" });
  const first = s.get("a")!.since;
  s.event("a", { event: "input.requested", kind: "plan" });
  expect(s.get("a")).toMatchObject({ state: "waiting", kind: "plan" });
  expect(s.get("a")!.since).toBeGreaterThan(first);
});

test("a wait that begins within the same millisecond as the one before is still named apart: its since is later", () => {
  const s = new StatusStore({ now: () => 1000 });
  s.event("a", { event: "input.requested", kind: "permission" });
  const first = s.get("a")!.since;
  s.event("a", { event: "input.resolved" });
  s.event("a", { event: "input.requested", kind: "permission" });
  expect(s.get("a")!.since).toBeGreaterThan(first);
});

test("a wait the screen says it is carries what it says; another screen is a new wait, and anything but the screen or a title clears it", () => {
  const s = store();
  s.screen("a", "permission", "trust");
  expect(s.get("a")).toMatchObject({ state: "waiting", kind: "permission", says: "trust", source: "screen" });
  const trust = s.get("a")!.since;
  s.screen("a", "permission", "trust");
  s.title("a", "Claude Code");
  expect(s.get("a")).toMatchObject({ says: "trust", since: trust });
  s.screen("a", "permission", "settings");
  expect(s.get("a")).toMatchObject({ kind: "permission", says: "settings" });
  expect(s.get("a")!.since).toBeGreaterThan(trust);
  const settings = s.get("a")!.since;
  s.screen("a", "permission");
  expect(s.get("a")!.says).toBeUndefined();
  expect(s.get("a")!.since).toBeGreaterThan(settings);
  s.screen("a", "permission", "trust");
  s.screen("a", "working", "trust");
  expect(s.get("a")).toMatchObject({ state: "working" });
  expect(s.get("a")!.says).toBeUndefined();
  s.screen("a", "permission", "trust");
  s.event("a", { event: "input.requested", kind: "permission" });
  expect(s.get("a")).toMatchObject({ state: "waiting", kind: "permission", source: "hooks" });
  expect(s.get("a")!.says).toBeUndefined();
});

test("a title rides the session record: set, cleared by an empty title, gone at exit", () => {
  const s = store();
  s.screen("a", "working");
  s.title("a", "Fix the flaky test");
  expect(s.get("a")).toMatchObject({ state: "working", title: "Fix the flaky test" });
  s.title("a", "");
  expect(s.get("a")!.title).toBeUndefined();
  s.title("a", "Refactor auth");
  s.exited("a");
  expect(s.get("a")!.title).toBeUndefined();
  s.title("a", "late");
  expect(s.get("a")!.title).toBeUndefined();
});

test("the session is the one the hooks last said: a new one alone is a change; what says none keeps it, and so does the end, to resume it", () => {
  const s = store();
  const told: StatusChange[] = [];
  s.subscribe((c) => told.push(c));
  s.event("a", { event: "session.started", sessionId: "s1" });
  s.event("a", { event: "session.started", sessionId: "s1" });
  expect(told.map((c) => c.status.session)).toEqual(["s1"]);
  s.event("a", { event: "session.started", sessionId: "s2" }); // cleared: still idle, in another session
  expect(told.map((c) => [c.status.state, c.status.session])).toEqual([["idle", "s1"], ["idle", "s2"]]);
  s.event("a", { event: "turn.started" });
  s.title("a", "Fix it");
  s.screen("a", "blocked");
  s.event("a", { event: "turn.ended", outcome: "done" });
  s.exited("a");
  expect(s.get("a")).toMatchObject({ state: "exited", session: "s2" });
});

test("a session another machine hosts shows that host's status; nothing seen here changes it but its end", () => {
  const s = store();
  const told: StatusChange[] = [];
  s.subscribe((c) => told.push(c));
  const hosts: SessionStatus = { state: "working", source: "hooks", since: 5, subagents: ["s1"], background: 0, compacting: false, title: "Fix it" };
  s.screen("r", "blocked"); // read here before the host's status arrived
  s.mirror("r", hosts);
  expect(s.get("r")).toEqual(hosts);
  s.event("r", { event: "turn.ended", outcome: "done" });
  s.screen("r", "idle");
  s.input("r", "\x03");
  s.title("r", "Something else");
  expect(s.get("r")).toEqual(hosts);
  s.mirror("r", { ...hosts, state: "done", subagents: [] });
  expect(s.get("r")).toMatchObject({ state: "done", subagents: [] });
  // The host read it from the screen: a screen read here does not change it either.
  s.mirror("r", { ...hosts, state: "working", source: "screen" });
  s.screen("r", "idle");
  expect(s.get("r")).toMatchObject({ state: "working", source: "screen" });
  s.exited("r");
  expect(s.get("r")!.state).toBe("exited");
  expect(told.map((c) => c.status.state)).toEqual(["waiting", "working", "done", "working", "exited"]);
  // Forgotten, the session is this store's own again.
  s.forget("r");
  s.screen("r", "working");
  expect(s.get("r")).toMatchObject({ state: "working", source: "screen" });
});

test("only a status as a host sends it is taken from the wire", () => {
  const ok: SessionStatus = { state: "waiting", kind: "permission", source: "hooks", since: 1, subagents: [], background: 2, compacting: false };
  expect(isSessionStatus(ok)).toBe(true);
  expect(isSessionStatus({ ...ok, source: null, kind: undefined, title: "t" })).toBe(true);
  expect(isSessionStatus({ ...ok, source: "screen", says: "trust" })).toBe(true);
  expect(isSessionStatus({ ...ok, session: "5f0c3a1e" })).toBe(true);
  for (const bad of [null, "working", { ...ok, state: "busy" }, { ...ok, kind: "coffee" }, { ...ok, subagents: [1] }, { ...ok, source: "guess" },
    { ...ok, since: "now" }, { ...ok, background: "2" }, { ...ok, compacting: 1 }, { ...ok, title: 7 }, { ...ok, says: 7 }, { ...ok, session: 7 }]) {
    expect(isSessionStatus(bad)).toBe(false);
  }
});

test("subagents whose stop never came stop counting once no subagent edge has come for the grace window, on the store that hosts the session", () => {
  jest.useFakeTimers();
  try {
    const s = new StatusStore();
    s.event("a", { event: "turn.started" });
    for (const agentId of ["x", "y", "z"]) s.event("a", { event: "subagent.started", agentId });
    s.event("a", { event: "subagent.stopped", agentId: "x" });
    s.event("a", { event: "turn.ended", outcome: "done" }); // y and z never report their stop
    jest.advanceTimersByTime(SUBAGENT_GRACE_MS - 1);
    expect(s.get("a")).toMatchObject({ state: "done", subagents: ["y", "z"] });
    jest.advanceTimersByTime(1);
    expect(s.get("a")).toMatchObject({ state: "done", subagents: [] });

    // A mirror shows its host's subagents, never drained here.
    const viewer = new StatusStore();
    viewer.mirror("a", { ...s.get("a")!, subagents: ["y"] });
    jest.advanceTimersByTime(SUBAGENT_GRACE_MS);
    expect(viewer.get("a")?.subagents).toEqual(["y"]);
  } finally {
    jest.useRealTimers();
  }
});
