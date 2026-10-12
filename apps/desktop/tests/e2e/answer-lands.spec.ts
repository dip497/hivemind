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
async function started(late = 2): Promise<{ desktop: Page; repo: string; tile: string; log: () => string; deaf: string; asking: () => Promise<{ state: string; since: number; waiting?: unknown }> }> {
  const repo = path.join(root, "api");
  fs.mkdirSync(repo);
  execSync("git init -q", { cwd: repo });
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const env = chooserAgent(root);
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

test("an Allow its chooser does not take says it failed, and the person may answer again", async () => {
  test.setTimeout(120_000);
  const { desktop, tile, log, asking, deaf } = await started();
  fs.writeFileSync(deaf, "");
  await desktop.evaluate((t) => window.hive.ptyWrite(`hm:${t}`, "perm\r"), tile);
  let since = 0;
  await expect.poll(async () => { const a = await asking(); since = a.since; return a.state; }, { timeout: 20_000, intervals: [20] }).toBe("waiting");
  expect(await refusal(desktop, tile, since)).toMatch(/the keys went in, but its screen still asks/);
  expect(log()).toBe("ignored 1\n");
  fs.rmSync(deaf);
  // Still asking, and said so: answered again, it lands.
  const again = await asking();
  expect(again).toMatchObject({ state: "waiting", waiting: { kind: "permission" } });
  expect(await refusal(desktop, tile, again.since)).toBe("");
  expect(log()).toBe("ignored 1\ntook 1\n");
});
