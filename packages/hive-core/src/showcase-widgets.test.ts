// The showcase widgets in examples/widgets, each run as the app runs it: the widget API's prelude
// and the widget's own code in one worker scope, driven by the messages the window sends (start,
// a press, hive.hm's callbacks, an agent's command), and judged by what it draws and answers.
import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { WIDGET_PRELUDE } from "./widget-api";
import { readWidget } from "./widgets";

const ROOT = path.resolve(import.meta.dir, "../../../examples/widgets");
type Msg = { type: string; [k: string]: unknown };
type Node = { type: string; text?: string; value?: unknown; label?: string; src?: string; tint?: string; action?: unknown; max?: number; children?: Node[] };

/** One widget's worker: its prelude and code, the messages it posted, and the window's side of hive.hm. */
function run(name: string, { state, options = {}, replies = {}, values = true }: { state?: unknown; options?: Record<string, unknown>; replies?: Record<string, unknown>; values?: boolean } = {}) {
  const posted: Msg[] = [];
  const self: { onmessage?: (e: { data: Msg }) => void } = {};
  const fns = new Map<string, number[]>();
  const calls: { path: string[]; args: unknown[] }[] = [];
  let answers = 0;
  const pending = new Map<number, unknown>();
  const send = (m: Msg) => self.onmessage!({ data: m });
  const postMessage = (m: Msg) => {
    posted.push(m);
    if (m.type === "hm-answer") pending.set(m.answer as number, m.ok ? m.value : { error: m.error });
    if (m.type !== "hm-call") return;
    const p = m.path as string[];
    const args = (m.args as unknown[]).map((a) => ((a as { __fn?: number })?.__fn ? `fn:${(a as { __fn: number }).__fn}` : a));
    calls.push({ path: p, args });
    const fn = (m.args as { __fn?: number }[]).find((a) => a?.__fn)?.__fn;
    const key = p.join(".") === "onCommand" || p.join(".") === "on" ? `${p.join(".")}:${String(args[0])}` : p.join(".");
    if (fn) fns.set(key, [...(fns.get(key) ?? []), fn]);
    else void Promise.resolve(replies[p.join(".")] ?? null).then((value) => send({ type: "hm-reply", req: m.req as number, ok: true, value }));
  };
  const code = readFileSync(path.join(ROOT, name, "widget.js"), "utf8");
  new Function("self", "postMessage", "setInterval", "setTimeout", WIDGET_PRELUDE + code)(self, postMessage, () => 0, () => 0);
  if (values) send({ type: "hm-values", values: { capabilities: ["workspace:spawn", "workspace:prompt", "workspace:issues"] } });
  send({ type: "init", state, options });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return {
    posted,
    calls,
    /** What it drew last. */
    tree: () => [...posted].reverse().find((m) => m.type === "render")?.tree as Node,
    state: () => [...posted].reverse().find((m) => m.type === "state")?.state as Record<string, unknown>,
    notes: () => posted.filter((m) => m.type === "notify").map((m) => m.text),
    press: async (action: unknown) => { send({ type: "action", payload: action }); await tick(); },
    /** Call back what it handed hive.hm for `key` (e.g. "on:structure", "subscribeStatus"). */
    fire: async (key: string, ...args: unknown[]) => {
      for (const fn of fns.get(key) ?? []) send({ type: "hm-cb", fn, args });
      await tick();
    },
    /** A `hive ctl view emit`: to each onCustom whose pattern names it, as the host matches them. */
    emit: async (name: string, data: unknown) => {
      for (const c of calls.filter((x) => x.path[0] === "onCustom")) {
        const patterns = ([] as string[]).concat(c.args[0] as string);
        if (patterns.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : p === name))) send({ type: "hm-cb", fn: Number(String(c.args[1]).slice(3)), args: [{ kind: "custom", name, data }] });
      }
      await tick();
    },
    /** Each callback handed to `key`, separately: the n-th subscription. */
    fireNth: async (key: string, n: number, ...args: unknown[]) => { send({ type: "hm-cb", fn: fns.get(key)![n]!, args }); await tick(); },
    /** Run an agent's command and get its answer, or { error }. */
    command: async (cmd: string, args?: unknown) => {
      const fn = fns.get(`onCommand:${cmd}`)?.[0];
      if (!fn) throw new Error(`it does not answer ${cmd}`);
      const answer = ++answers;
      send({ type: "hm-cb", fn, args: [args], answer });
      for (let i = 0; i < 10 && !pending.has(answer); i++) await tick();
      return pending.get(answer) as Record<string, unknown>;
    },
  };
}

const flat = (n: Node | undefined): Node[] => (n ? [n, ...(n.children ?? []).flatMap(flat)] : []);
const texts = (n: Node | undefined) => flat(n).flatMap((x) => [x.text, x.label, x.value === undefined ? undefined : String(x.value)]).filter((t): t is string => !!t);

test("every showcase widget in the repository reads as a widget, with the commands an agent runs", async () => {
  for (const name of readdirSync(ROOT)) {
    const w = await readWidget(path.join(ROOT, name));
    expect([name, w.code.length > 0, w.commands.length > 0]).toEqual([name, true, true]);
  }
});

test("CI light: a failed report turns it red with its detail, notifies once, and its button asks an agent to fix that build", async () => {
  const w = run("ci-light");
  expect(texts(w.tree())).toContain("No build yet");
  await w.command("set", { state: "failed", name: "CI", branch: "main", detail: "typecheck: 2 errors" });
  await w.command("set", { state: "failed", name: "CI", branch: "main", detail: "typecheck: 2 errors" });
  const tree = w.tree();
  expect(flat(tree).find((n) => n.type === "image")?.src).toBe("light-failed.svg");
  expect(texts(tree)).toContain("typecheck: 2 errors");
  expect(w.notes()).toEqual(["CI failed on main"]);
  await w.press("fix");
  const spawn = w.calls.find((c) => c.path.join(".") === "commands.spawnAgent");
  expect((spawn?.args[2] as { prompt: string }).prompt).toContain('The build "CI" on main failed: typecheck: 2 errors');
  expect(await w.command("set", { state: "green" })).toEqual({ error: "state must be one of passed, failed, running, unknown" });
  await w.command("set", { state: "passed" });
  expect(flat(w.tree()).find((n) => n.type === "image")?.src).toBe("light-passed.svg");
  expect(flat(w.tree()).some((n) => n.type === "button")).toBe(false);
});

test("CI light: a `hive ctl view emit ci.build` event sets it as the command does", async () => {
  const w = run("ci-light");
  await w.emit("ci.build", { state: "running", name: "Deploy" });
  expect(texts(w.tree())).toContain("Build running");
});

test("Test meter: a run reported shows the share passing and its failures, and earlier runs stay below it", async () => {
  const w = run("test-meter");
  await w.command("report", { passed: 40, failed: 0 });
  await w.command("report", { passed: 397, failed: 3, skipped: 2, failing: ["auth › refresh"] });
  const all = texts(w.tree());
  expect(all).toContain("99.2%");
  expect(all).toContain("Failing: auth › refresh");
  expect(all.some((t) => t.startsWith("✓ 40 passed"))).toBe(true);
  expect(flat(w.tree()).find((n) => n.type === "image")?.src).toBe("failing.svg");
  expect(w.notes()).toEqual(["3 tests failing"]);
  expect(await w.command("report", { passed: "many" })).toEqual({ error: "passed and failed must be numbers" });
});

test("Spend today: reports add up per agent, the budget notifies once when crossed, and yesterday's total is not today's", async () => {
  const w = run("spend-today", { options: { budget: 5 }, state: { day: "Mon Jan 01 2001", by: { old: { usd: 99, tokens: 1 } } } });
  expect(texts(w.tree())).toContain("$0.00");
  await w.command("add", { usd: 3, tokens: 1_200_000, agent: "claude" });
  await w.command("add", { usd: 2.5, tokens: 300_000, agent: "claude" });
  await w.command("add", { usd: 1, agent: "codex" });
  const today = await w.command("today");
  expect([today.usd, today.tokens, today.byAgent]).toEqual([6.5, 1_500_000, { claude: { usd: 5.5, tokens: 1_500_000 }, codex: { usd: 1, tokens: 0 } }]);
  expect(w.notes()).toEqual(["Today's agent budget of $5.00 is spent."]);
  expect(texts(w.tree())).toContain("over today's $5.00");
  expect(await w.command("add", { usd: -2 })).toEqual({ error: "add needs usd or tokens, as positive numbers" });
});

test("Focus timer: started for a length it counts that down, and paused it keeps the time left", async () => {
  const w = run("focus-timer", { options: { focus: 25, break: 5 } });
  expect(texts(w.tree())).toContain("25:00");
  expect(await w.command("start", { minutes: 10 })).toEqual({ phase: "focus", running: true, left: "10:00", rounds: 0 });
  const paused = await w.command("pause");
  expect([paused.running, paused.left]).toEqual([false, "10:00"]);
  expect(texts(w.tree())).toContain("Resume");
  await w.press("switch");
  expect(texts(w.tree())).toContain("05:00");
});

test("Waiting on you: an agent that asks shows with why, longest first; pressing it focuses it; answered, it leaves", async () => {
  const w = run("waiting-on-you");
  await w.fire("on:structure", { tiles: [{ id: "a", agent: "claude", name: "tests" }, { id: "b", agent: "codex", name: "docs" }, { id: "t", kind: "term", name: "shell" }] });
  expect(w.calls.filter((c) => c.path[0] === "subscribeStatus").map((c) => c.args[0])).toEqual(["a", "b"]);
  await w.fireNth("subscribeStatus", 1, "blocked", { since: Date.now() - 120_000, agent: { state: "waiting", waitingFor: "question" } });
  await w.fireNth("subscribeStatus", 0, "blocked", { since: Date.now() - 5_000, agent: { state: "waiting", waitingFor: "permission" } });
  const buttons = flat(w.tree()).filter((n) => n.type === "button");
  expect(buttons.map((b) => b.label)).toEqual(["docs asked you something · 2m", "tests wants permission · 5s"]);
  await w.press(buttons[0]!.action);
  expect(w.calls.find((c) => c.path.join(".") === "commands.focusTile")?.args).toEqual(["b"]);
  await w.fireNth("subscribeStatus", 1, "working", { agent: { state: "working" } });
  await w.fireNth("subscribeStatus", 0, "working", { agent: { state: "working" } });
  expect(texts(w.tree())).toContain("All 2 agents are getting on with it.");
});

test("Agent pulse: it counts agents by what they are doing, and today's turns from history plus each turn after", async () => {
  let answer = (_: unknown) => {};
  const history = new Promise((r) => { answer = r; });
  const w = run("agent-pulse", { replies: { history } });
  await w.fire("on:structure", { tiles: [{ id: "a", agent: "claude" }, { id: "b", agent: "codex" }, { id: "c", agent: "pi" }] });
  await w.fireNth("subscribeStatus", 0, "working", { agent: { state: "working" } });
  await w.fireNth("subscribeStatus", 1, "blocked", { agent: { state: "waiting" } });
  await w.fireNth("subscribeStatus", 2, "idle", { agent: { state: "idle" } });
  // A turn that ends while the day's history is on its way counts as well as the ones before it.
  await w.fire("onEvents", { kind: "turn" });
  answer({ tiles: [{ turns: [1, 2, 3] }, { turns: [4] }] });
  await new Promise((r) => setTimeout(r, 0));
  expect(await w.command("status")).toEqual({ working: 1, waiting: 1, idle: 1, stuck: 0, turnsToday: 5 });
  expect(texts(w.tree())).toContain("33% of 3 agents busy");
});

test("Issue burndown: an issue is open each day from its creation until the day it was closed", async () => {
  const w = run("issue-burndown", { options: { days: 3 } });
  const day = (n: number) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - n); return d.toISOString(); };
  await w.fire("onIssues", [
    { id: "A-1", state: "todo", created: day(5), updated: day(5) },
    { id: "A-2", state: "done", created: day(5), updated: day(1) },
    { id: "A-3", state: "in_progress", created: new Date(Date.now() - 1000).toISOString(), updated: new Date().toISOString() },
    { id: "A-4", state: "cancelled", created: day(4), updated: day(3) },
  ]);
  expect((await w.command("burndown") as unknown as { open: number }[]).map((d) => d.open)).toEqual([2, 1, 2]);
  expect(flat(w.tree()).filter((n) => n.type === "meter").map((n) => n.value)).toEqual([2, 1, 2]);
});

test("Launchpad: a press starts the default agent with that button's job as its message", async () => {
  const w = run("launchpad", { options: { twoLabel: "Ship it", two: "Cut the release." } });
  const button = flat(w.tree()).find((n) => n.label === "▶  Ship it")!;
  await w.press(button.action);
  expect(w.calls.find((c) => c.path.join(".") === "commands.spawnAgent")?.args).toEqual([null, null, { name: "Ship it", prompt: "Cut the release." }]);
});

test("a widget that reads what it may do draws at once, before the app has sent hive.hm's values", async () => {
  for (const name of ["ci-light", "launchpad"]) {
    const w = run(name, { values: false });
    expect([name, w.tree()?.type]).toEqual([name, "stack"]);
  }
});
