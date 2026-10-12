// An answer lands on the screen it answers (spec/needs.md "Answering"). Claude Code reports a
// permission it waits on (its PermissionRequest hook) before its chooser takes keys; a stand-in
// agent that draws its chooser late shows what an Allow typed at once does: the computer waits for
// the chooser before typing, and says it was answered only once the chooser took it. And what
// waits on the person goes once the chooser does, whatever was pressed before it was drawn.
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { person } from "./helpers/multiplayer";
import { chooserAgent } from "./helpers/chooser";
import { stopDaemons } from "./helpers/daemons";

let root: string;
const apps: ElectronApplication[] = [];
test.beforeEach(() => { root = fs.mkdtempSync("/tmp/hm-answer-"); });
test.afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  stopDaemons(root);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** The desktop, with the stand-in as its agent, and the one it started. */
async function started(late = 2, held = false, hookFor?: number): Promise<{ desktop: Page; repo: string; tile: string; log: () => string; deaf: string; asking: () => Promise<{ state: string; since: number; waiting?: unknown }> }> {
  const repo = path.join(root, "api");
  fs.mkdirSync(repo);
  execSync("git init -q", { cwd: repo });
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const env = chooserAgent(root, { held, hookFor });
  const desktop = await person(root, "desktop", repo, apps, { ...env, CHOOSER_LATE: String(late), HIVEMIND_SHELL_ENV: "0", HOME: home, ...(process.env.CHOOSER_TRACE ? { CHOOSER_TRACE: process.env.CHOOSER_TRACE } : {}) });
  await desktop.evaluate(() => window.hive.settingsSet("agents.defaultAgent", "chooser"));
  await desktop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:shortcut", { detail: "agent" })));
  await expect(desktop.locator(".react-flow__node-terminal")).toHaveCount(1, { timeout: 20_000 });
  const tile = (await desktop.locator(".react-flow__node-terminal").getAttribute("data-id"))!;
  const log = () => (fs.existsSync(env.CHOOSER_LOG) ? fs.readFileSync(env.CHOOSER_LOG, "utf8") : "");
  const asking = async () => (await desktop.evaluate((r) => window.hive.agentList(r), repo)).agents.find((a) => a.tile === tile)!;
  await expect.poll(async () => (await asking())?.state, { timeout: 30_000 }).toBe("idle");
  return { desktop, repo, tile, log, asking, deaf: env.CHOOSER_LOG + ".deaf" };
}

test("an Allow given the moment the agent asks, before its chooser takes keys, is typed once the chooser is drawn and lands there", async () => {
  test.setTimeout(120_000);
  const { desktop, tile, log, asking } = await started();
  await desktop.evaluate((t) => window.hive.ptyWrite(`hm:${t}`, "perm\r"), tile);
  let since = 0;
  await expect.poll(async () => { const a = await asking(); since = a.since; return a.state; }, { timeout: 20_000, intervals: [20] }).toBe("waiting");
  const answered = await desktop.evaluate(([t, s]) => window.hive.agentAnswer(t, s, { decision: "allow" }), [tile, since] as const);
  // Said to have landed only once the chooser took it.
  expect({ answered, log: log() }).toEqual({ answered: { answered: true }, log: "took 1\n" });
  await expect.poll(async () => (await asking()).state, { timeout: 20_000 }).not.toBe("waiting");
});

test("an Allow given long after the chooser is drawn, its screen quiet since, lands there", async () => {
  test.setTimeout(120_000);
  const { desktop, tile, log, asking } = await started();
  await desktop.evaluate((t) => window.hive.ptyWrite(`hm:${t}`, "perm\r"), tile);
  await expect.poll(async () => (await asking()).state, { timeout: 20_000, intervals: [20] }).toBe("waiting");
  // Drawn, then nothing more on its screen for longer than an answer waits on it.
  await desktop.waitForTimeout(20_000);
  const { since } = await asking();
  const answered = await desktop.evaluate(([t, s]) => window.hive.agentAnswer(t, s, { decision: "allow" }), [tile, since] as const);
  expect({ answered, log: log() }).toEqual({ answered: { answered: true }, log: "took 1\n" });
  await expect.poll(async () => (await asking()).state, { timeout: 20_000 }).not.toBe("waiting");
});

test("a chooser cancelled with Esc waits on the person no more, though a key was pressed before it was drawn", async () => {
  test.setTimeout(120_000);
  const { desktop, tile, log, asking } = await started();
  await desktop.evaluate((t) => window.hive.ptyWrite(`hm:${t}`, "perm\r"), tile);
  await expect.poll(async () => (await asking()).state, { timeout: 20_000, intervals: [20] }).toBe("waiting");
  // Pressed at once, the key never reaches the chooser.
  await desktop.evaluate((t) => window.hive.ptyWrite(`hm:${t}`, "1"), tile);
  await expect.poll(log, { timeout: 15_000 }).toContain("missed 1");
  // The chooser, drawn, waits on the person.
  await expect.poll(async () => (await asking()).state, { timeout: 20_000 }).toBe("waiting");
  await desktop.evaluate((t) => window.hive.ptyWrite(`hm:${t}`, "\x1b"), tile);
  await expect.poll(log, { timeout: 15_000 }).toContain("took esc");
  await expect.poll(async () => (await asking()).state, { timeout: 20_000 }).not.toBe("waiting");
  // And stays so at its prompt.
  await desktop.waitForTimeout(5_000);
  expect((await asking()).state).not.toBe("waiting");
});

/** The error `agent.answer` gave, as the window heard it; "" when it answered. */
const refusal = (desktop: Page, tile: string, since: number) => desktop.evaluate(([t, s]) => window.hive.agentAnswer(t, s, { decision: "allow" }).then(() => "", (e: Error) => e.message), [tile, since] as const);

test("an Allow for a chooser not drawn in time types nothing and says so", async () => {
  test.setTimeout(120_000);
  const { desktop, tile, log, asking } = await started(9);
  await desktop.evaluate((t) => window.hive.ptyWrite(`hm:${t}`, "perm\r"), tile);
  let since = 0;
  await expect.poll(async () => { const a = await asking(); since = a.since; return a.state; }, { timeout: 20_000, intervals: [20] }).toBe("waiting");
  expect(await refusal(desktop, tile, since)).toMatch(/has not shown what it asks: nothing was typed/);
  // Drawn later, its chooser was typed nothing.
  await desktop.waitForTimeout(6_000);
  expect(log()).toBe("");
  expect((await asking()).state).toBe("waiting");
});

test("an Allow its chooser does not take is not confirmed, and is never typed again", async () => {
  test.setTimeout(120_000);
  const { desktop, tile, log, asking, deaf } = await started();
  fs.writeFileSync(deaf, "");
  await desktop.evaluate((t) => window.hive.ptyWrite(`hm:${t}`, "perm\r"), tile);
  let since = 0;
  await expect.poll(async () => { const a = await asking(); since = a.since; return a.state; }, { timeout: 20_000, intervals: [20] }).toBe("waiting");
  expect(await refusal(desktop, tile, since)).toMatch(/the keys went in, but its screen has not moved on yet: not confirmed/);
  expect(log()).toBe("ignored 1\n");
  // The keys went in: answered again, as the wait it named or as what it shows now, nothing is typed.
  const now = await asking();
  for (const s of new Set([since, now.since])) {
    expect(await desktop.evaluate(([t, at]) => window.hive.agentAnswer(t, at, { decision: "allow" }), [tile, s] as const)).toEqual({ answered: false });
  }
  await desktop.waitForTimeout(3_000);
  expect(log()).toBe("ignored 1\n");
});

test("a line its chooser does not take is not confirmed, and answered again, while it still waits on that, is never typed again", async () => {
  test.setTimeout(120_000);
  const { desktop, tile, log, asking, deaf } = await started();
  fs.writeFileSync(deaf, "");
  await desktop.evaluate((t) => window.hive.ptyWrite(`hm:${t}`, "perm\r"), tile);
  let since = 0;
  await expect.poll(async () => { const a = await asking(); since = a.since; return a.state; }, { timeout: 20_000, intervals: [20] }).toBe("waiting");
  const line = () => desktop.evaluate(([t, s]) => window.hive.agentAnswer(t, s, { text: "no" }).then((r) => r, (e: Error) => e.message), [tile, since] as const);
  expect(await line()).toMatch(/the keys went in, but its screen has not moved on yet: not confirmed/);
  const typed = log();
  expect(typed).toMatch(/^ignored n\nignored o\n/);
  // Typed, a line leaves it on the wait it answered.
  expect(await asking()).toMatchObject({ state: "waiting", since });
  expect(await line()).toEqual({ answered: false });
  await desktop.waitForTimeout(3_000);
  expect(log()).toBe(typed);
});

/** The stand-in asked, as one whose hook carries the answer: it and the wait it waits on. */
async function heldAsk(hookFor?: number): Promise<Awaited<ReturnType<typeof started>> & { since: number }> {
  const at = await started(2, true, hookFor);
  await at.desktop.evaluate((t) => window.hive.ptyWrite(`hm:${t}`, "perm\r"), at.tile);
  let since = 0;
  await expect.poll(async () => { const a = await at.asking(); since = a.since; return a.state; }, { timeout: 20_000, intervals: [20] }).toBe("waiting");
  return { ...at, since };
}

test("an Allow for an agent whose hook carries the answer, given the moment it asks, is printed by its hook and nothing is typed", async () => {
  test.setTimeout(120_000);
  const { desktop, tile, log, asking, since } = await heldAsk();
  expect(await desktop.evaluate(([t, s]) => window.hive.agentAnswer(t, s, { decision: "allow" }), [tile, since] as const)).toEqual({ answered: true });
  await expect.poll(log, { timeout: 15_000 }).toBe('drawn\nhook said {"decision":{"behavior":"allow"}}\n');
  await expect.poll(async () => (await asking()).state, { timeout: 20_000 }).not.toBe("waiting");
});

test("a line for an agent whose hook carries the answer denies through its hook, the line its reason", async () => {
  test.setTimeout(120_000);
  const { desktop, tile, log, since } = await heldAsk();
  expect(await desktop.evaluate(([t, s]) => window.hive.agentAnswer(t, s, { text: "use the staging database" }), [tile, since] as const)).toEqual({ answered: true });
  await expect.poll(log, { timeout: 15_000 }).toBe('drawn\nhook said {"decision":{"behavior":"deny","message":"use the staging database"}}\n');
});

test("answered at its own chooser first, the hook that carries the answer is let go, and an answer after does nothing", async () => {
  test.setTimeout(120_000);
  const { desktop, tile, log, since } = await heldAsk();
  await expect.poll(log, { timeout: 15_000 }).toBe("drawn\n");
  await desktop.evaluate((t) => window.hive.ptyWrite(`hm:${t}`, "1"), tile);
  await expect.poll(log, { timeout: 15_000 }).toBe("drawn\ntook 1\nhook let go\n");
  expect(await desktop.evaluate(([t, s]) => window.hive.agentAnswer(t, s, { decision: "allow" }), [tile, since] as const)).toMatchObject({ answered: false });
});

/** The tool what the agent of `tile` waits on is for, as the person's devices are told it. */
const toolOf = async (asking: () => Promise<{ waiting?: unknown }>) => ((await asking()).waiting as { tool?: { name: string } } | undefined)?.tool?.name;

test("a hook that carries the answer, ended by its agent while its chooser stays up, lets go of the wait, and an Allow after is typed there", async () => {
  test.setTimeout(120_000);
  const { desktop, tile, log, asking, since } = await heldAsk(4);
  // Held, what it waits on is what its hook said.
  await expect.poll(() => toolOf(asking), { timeout: 10_000 }).toBe("Bash");
  await expect.poll(log, { timeout: 15_000 }).toBe("drawn\nhook let go\n");
  await expect.poll(() => toolOf(asking), { timeout: 10_000 }).toBeUndefined();
  expect(await asking()).toMatchObject({ state: "waiting", since });
  expect(await desktop.evaluate(([t, s]) => window.hive.agentAnswer(t, s, { decision: "allow" }), [tile, since] as const)).toEqual({ answered: true });
  expect(log()).toBe("drawn\nhook let go\ntook 1\n");
});
