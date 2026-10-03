import { expect, test } from "bun:test";
import { StatusStore, isSessionStatus, type SessionStatus, type StatusChange } from "../src/status-store.js";

const store = () => { let t = 1000; const s = new StatusStore({ now: () => ++t, logSize: 5 }); return s; };

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

test("exit is final whatever the source says next", () => {
  const s = store();
  s.screen("a", "working");
  s.exited("a");
  s.screen("a", "working");
  s.event("a", { event: "turn.started" });
  expect(s.get("a")!.state).toBe("exited");
});

test("changes carry a sequence a client resumes from; past the log's reach it must take a snapshot", () => {
  const s = store();
  const seen: StatusChange[] = [];
  s.subscribe((c) => seen.push(c));
  s.event("a", { event: "turn.started" });
  s.event("a", { event: "turn.started" }); // no change, no entry
  s.event("a", { event: "subagent.started", agentId: "x" });
  expect(seen.map((c) => c.seq)).toEqual([1, 2]);
  expect(s.since(1)!.map((c) => c.seq)).toEqual([2]);
  expect(s.since(2)).toEqual([]);
  for (let i = 0; i < 10; i++) s.event("b", { event: i % 2 ? "turn.started" : "turn.ended" });
  expect(s.since(0)).toBeNull();
  expect(s.since(s.cursor() - 2)!.length).toBe(2);
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
  for (const bad of [null, "working", { ...ok, state: "busy" }, { ...ok, kind: "coffee" }, { ...ok, subagents: [1] }, { ...ok, source: "guess" },
    { ...ok, since: "now" }, { ...ok, background: "2" }, { ...ok, compacting: 1 }, { ...ok, title: 7 }]) {
    expect(isSessionStatus(bad)).toBe(false);
  }
});
