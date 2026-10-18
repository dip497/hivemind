// The demo's frames, recorded once from the real app, the real phone page paired with it and real
// agents, over the demo workspace (demo-workspace.sh). Run by demo-media.mjs, never by the e2e
// suite. See docs/design/demo-media-2026-10-18.md.
import { test, expect, chromium, type ElectronApplication } from "@playwright/test";
import { type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hiveNetBuilt, ownNetwork } from "../../tests/e2e/helpers/multiplayer";
import { connectPage, offerToConnect } from "../../tests/e2e/helpers/phone";
import { stopDaemons } from "../../tests/e2e/helpers/daemons";
import { DEMO, OUT, WWW, demoInstructions, recorder, runnerSettings, stage } from "./stage";

// Each agent's job, as a person would give it. The docs agent asks before its edit and waits on
// the person; the reviewer is asked for a fix later, which the person allows from the phone.
const ASK_WIDGET = "Run hive widgets new fas-1-board --owner hivemind here, make it show FAS-1 with its whole title, wrapped (wrap: true) rather than cut short, and ticked rows readable, not muted, and install it. Then do FAS-1, ticking each criterion as you go";
const ASK_EDIT = "Add a short docstring to generate_encoders_by_class_tuples in fastapi/encoders.py";
const ASK_GLOB = "Read how --glob and --iglob are combined in crates/core/flags/defs.rs and crates/globset/src/lib.rs, then add a short paragraph to GUIDE.md on the order they apply in, with one example";
const ASK_REVIEW = "Review this branch: read git diff main, then packages/element/src/binding.ts and its tests, and list what could break";
const ASK_FIX = "Fix the first problem you listed";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-demo-"));
const apps: ElectronApplication[] = [];
const procs: ChildProcess[] = [];
test.afterAll(async () => {
  for (const a of apps) await Promise.race([a.close(), new Promise((r) => setTimeout(r, 8000))]);
  for (const p of procs) p.kill("SIGKILL");
  stopDaemons(root);
});

test("capture", async () => {
  test.skip(!hiveNetBuilt() || !fs.existsSync(path.join(WWW, "main.js")), "build hive-net and the phone page first");
  test.skip(!fs.existsSync(path.join(DEMO, "fastapi/.hivemind")), "run demo-workspace.sh first");
  test.setTimeout(1_500_000);

  const settingsUnchanged = runnerSettings();
  demoInstructions(["fastapi", "arrow-binding", "glob-order"]);

  const net = await ownNetwork(root, procs, "closed", WWW);
  const s = await stage(root, apps);
  const { desktop, app, cli, emit, census } = s;
  expect(await desktop.evaluate((l) => window.hive.useNetwork(l), net.link)).toMatchObject({ admission: "enrolled" });
  const frameIds = await s.openFrames(["fastapi", "arrow-binding", "glob-order"]);

  // Four real agents, each on a job you can name.
  const builder = await s.agent(frameIds.fastapi, "release-board", "acceptEdits");
  const asker = await s.agent(frameIds.fastapi, "docstrings", "default");
  const globber = await s.agent(frameIds["glob-order"], "glob-docs", "acceptEdits");
  const reviewer = await s.agent(frameIds["arrow-binding"], "arrow-review", "default");
  const { show, names } = s;

  // The phone page, paired as a person pairs it.
  const link = await offerToConnect(desktop, true);
  const browser = await chromium.launch();
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "dark" })).newPage();
  await phone.goto(link);
  await connectPage(phone, desktop);
  await desktop.keyboard.press("Escape");
  await desktop.waitForTimeout(800);
  await s.tidy(Object.values(frameIds));

  const rec = recorder(app, OUT);
  const { beat, burst, boxes } = rec;
  const phoneShot = (name: string) => rec.still(phone, `phone-${name}`);
  const tile = (id: string) => `.react-flow__node[data-id="${id}"]`;

  // 1. The board: each agent on its job, and one waiting on the person.
  cli("ctl", "send", asker, ASK_EDIT);
  await expect.poll(() => census().of(asker)?.waiting?.kind ?? "", { timeout: 300_000, intervals: [1000] }).toBe("permission").catch((e) => { console.log(show()); throw e; });
  cli("ctl", "send", globber, ASK_GLOB);
  cli("ctl", "send", reviewer, ASK_REVIEW);
  await expect.poll(() => [globber, reviewer].filter((t) => census().of(t)?.state === "working").length, { timeout: 120_000, intervals: [500] }).toBe(2).catch((e) => { console.log(show()); throw e; });
  const before = census();
  await s.quiet();
  await burst("working");
  // Every tile where the board shows it, for the opening that builds the board tile by tile.
  const tiles = await desktop.locator(".react-flow__node-terminal").evaluateAll((els) => els.map((e) => {
    const r = e.getBoundingClientRect();
    return { x: r.x * 2, y: r.y * 2, w: r.width * 2, h: r.height * 2 };
  }));
  await rec.box(desktop, tile(builder), "builderWide");
  await rec.box(desktop, tile(asker), "askerWide");

  // 2. The person answers the one that waits: in its tile, on the question it shows.
  await emit("hivemind:focus-tile", asker);
  await desktop.waitForTimeout(1500);
  await rec.box(desktop, tile(asker), "askerClose");
  await burst("asking-close", 6);
  await desktop.locator(`${tile(asker)} .xterm`).first().click();
  const answering = beat("answering");
  await answering();
  await desktop.keyboard.press("Enter");
  for (let i = 0; i < 12; i++) { await desktop.waitForTimeout(500); await answering(); }
  expect(census().of(asker)?.waiting, show()).toBeUndefined();
  const answered = census();

  // 3. Close on the builder; the pointer rests beside it, where a board widget lands.
  await emit("hivemind:focus-tile", builder);
  await desktop.waitForTimeout(1500);
  await desktop.locator('button[title^="Zoom out"]').first().click();
  await desktop.waitForTimeout(1200);
  const close = await rec.box(desktop, tile(builder), "builderClose");
  await burst("builder-close");

  // 4. The person types one line to it.
  await desktop.locator(`${tile(builder)} .xterm`).first().click();
  const beside = { x: close.x / 2 + close.w / 2 + 40, y: close.y / 2 + 20 };
  await desktop.mouse.move(beside.x, beside.y, { steps: 4 });
  const typing = beat("typing");
  for (const word of ASK_WIDGET.split(" ")) {
    await desktop.keyboard.type(`${word} `, { delay: 30 });
    await typing();
  }
  await desktop.keyboard.press("Enter");

  // 5. It builds, installs and places the widget, then works the issue, ticking it.
  const criteria = () => {
    try { return (JSON.parse(cli("show", "FAS-1", "--json").stdout).data.sections.acceptanceCriteria ?? []) as { done: boolean; text: string }[]; } catch { return []; }
  };
  const issueDone = () => { const c = criteria(); return c.length > 0 && c.every((x) => x.done); };
  const building = beat("building");
  const states: string[] = [];
  let widget = "";
  let doneAt = 0;
  let lastBusy = Date.now();
  const drawn: string[] = [];
  for (const started = Date.now(); Date.now() - started < 12 * 60_000;) {
    await building();
    drawn.push(await desktop.locator(".react-flow__node-widget, [data-widget]").first().innerText({ timeout: 200 }).catch(() => ""));
    const row = census().of(builder);
    // Asked before a command while the issue is open: the person allows it from their phone.
    if (row?.waiting?.kind === "permission" && !issueDone()) {
      const allow = phone.getByRole("button", { name: /^allow/i }).first();
      if (await allow.isVisible().catch(() => false)) {
        await allow.click();
        states.push(`${Math.round((Date.now() - started) / 1000)}s allowed from the phone`);
      }
    }
    const state = `${row?.state}${row?.waiting ? ` ${row.waiting.kind}/${row.waiting.says ?? ""}` : ""}`;
    if (states.at(-1)?.endsWith(` ${state}`) !== true) states.push(`${Math.round((Date.now() - started) / 1000)}s ${state}`);
    if (!widget) {
      const listed = JSON.parse(cli("ctl", "plugin", "list", "--json").stdout || "{}") as { plugins?: { plugin: string; kind: string; state: string }[] };
      widget = listed.plugins?.find((p) => p.kind === "widget" && p.state === "ready")?.plugin ?? "";
    }
    // Done when the issue says so and the agent has stopped: then a few seconds more.
    if (widget && !doneAt && row?.state !== "working" && issueDone()) doneAt = Date.now();
    if (doneAt && Date.now() - doneAt > 5000) break;
    // Stopped for good with the issue still open: the recording is wrong, and the gate says so.
    if (row?.state !== "working" && !row?.waiting && Date.now() - lastBusy > 60_000) break;
    if (row?.state === "working" || row?.waiting) lastBusy = Date.now();
    await desktop.waitForTimeout(700);
  }
  const ticked = criteria();
  // A widget sits on the board or floats over it, as its widget.json says.
  await rec.box(desktop, ".react-flow__node-widget, [data-widget]", "widget").catch(() => { boxes.widget = { x: 0, y: 0, w: 0, h: 0 }; });
  await burst("built-close");
  await desktop.keyboard.press("Escape");
  await s.fit();
  await burst("built");
  const afterBuild = census();

  // 6. The phone clip: the reviewer is asked for a fix, asks before its edit, and the person allows it there.
  cli("ctl", "send", reviewer, ASK_FIX);
  await expect.poll(() => census().of(reviewer)?.waiting?.kind ?? "", { timeout: 300_000, intervals: [1000] }).toBe("permission").catch((e) => { console.log(show()); throw e; });
  await desktop.waitForTimeout(1200);
  const asking = census();
  await burst("asking");
  await rec.box(desktop, tile(reviewer), "reviewerWide");
  await emit("hivemind:focus-tile", reviewer);
  await desktop.waitForTimeout(1500);
  await burst("review-close");
  await phone.waitForTimeout(1500);
  await phoneShot("needs");
  await phone.getByText("arrow-review").first().click({ timeout: 15_000 });
  await phone.waitForTimeout(1200);
  await phoneShot("asks");
  const allow = phone.getByRole("button", { name: /^allow/i }).first();
  const ab = (await allow.boundingBox())!;
  boxes.allow = { x: ab.x * 2, y: ab.y * 2, w: ab.width * 2, h: ab.height * 2 };
  await allow.click();
  // The answer as it lands, before the agent goes on to its next step.
  await phone.waitForTimeout(800);
  await phoneShot("answered");
  await burst("answered-close", 3);
  // A fix can take more than one edit; each one it asks about, the person allows there too.
  for (let i = 0; i < 60 && census().of(reviewer)?.waiting; i++) {
    await phone.waitForTimeout(1000);
    if (census().of(reviewer)?.waiting && await allow.isVisible().catch(() => false)) await allow.click();
  }
  if (census().of(reviewer)?.waiting) await phone.screenshot({ path: path.join(OUT, "frames/phone-stuck.png") });
  expect(census().of(reviewer)?.waiting, `${show()}\n--- its screen:\n${cli("ctl", "read", reviewer, "--poll").stdout.slice(-1500)}`).toBeUndefined();
  await browser.close();

  rec.save({
    tiles,
    asked: { widget: ASK_WIDGET, edit: ASK_EDIT, glob: ASK_GLOB, review: ASK_REVIEW, fix: ASK_FIX },
    census: { before: before.by, answered: answered.by, afterBuild: afterBuild.by, asking: asking.by },
    widget: { id: widget, list: ticked, states, drawn },
  });
  settingsUnchanged([DEMO, root, ...Object.values(names)]);
  // The scene each clip promises: agents at their jobs with one waiting, a widget the agent built
  // and ticked, one agent waiting on the phone.
  expect(before.of(asker)?.waiting?.kind, show()).toBe("permission");
  expect(widget, "the agent put a widget on the board").not.toBe("");
  expect(asking.of(reviewer)?.waiting?.kind).toBe("permission");
});
