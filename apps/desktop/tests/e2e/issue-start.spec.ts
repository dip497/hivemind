// Starting work on a mirrored issue that is assigned to nobody (design jira-sync §10, §11.1, e2e 3):
// the issue is mirrored the way the Jira service mirrors one (`hive ingest`, no Jira plugin), and a
// tool plugin's service stands in for the Jira plugin's part, providing "Assign to me" (it assigns
// by mirroring what Jira then says, through `issue.ingest`). "work" on its card asks the start-work
// guard; the dialog says it is unassigned; "Assign to me and start" assigns it through the service,
// the person reads the agent's prompt, and the agent starts in the issue's own worktree frame, its
// tile recording the issue — so a second start is refused while it runs.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { updateIssue } from "@hivemind/core";
import { stopDaemons } from "./helpers/daemons";

test.use({ trace: "off" });

const APP_DIR = process.cwd();
const CLI = path.resolve(APP_DIR, "../cli/src/index.ts");
const FAKE = path.join(APP_DIR, "tests/e2e/fixtures/fake-agent.cjs");
const XDG = process.env.XDG_CONFIG_HOME!;
const userData = path.join(XDG, "hivemind-dev");
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hm-issue-start-")));
const repo = path.join(root, "payments");
const fakeBin = path.join(root, "bin");
// `gh` for the PR row's Address review: the shim (scripts/gh-shim) answers from this folder.
const GH_SHIM_BIN = path.resolve(APP_DIR, "../../scripts/gh-shim");
const ghState = path.join(root, "gh");
const SOURCE = "jira:acme/PAY";

const onPath = (bin: string) => {
  for (const d of (process.env.PATH ?? "").split(":")) if (fs.existsSync(path.join(d, bin))) return path.join(d, bin);
  throw new Error(`${bin} not on PATH`);
};
/** `hive` as the person at this machine, against this app. */
const hive = (args: string[], input?: string) => {
  const r = spawnSync(onPath("bun"), [CLI, ...args, "--json"], {
    cwd: repo, encoding: "utf8", ...(input !== undefined ? { input } : {}),
    env: { ...process.env, HIVEMIND_APP_DATA: userData, HCP_TOKEN: "", HIVEMIND_TILE: "", HIVE_DRIVE_SOCK: "", HIVE_HCP_SOCK: "" },
  });
  const last = (t: string) => { try { return JSON.parse(t.trim().split("\n").pop() || ""); } catch { return undefined; } };
  return { status: r.status, json: last(r.stdout) ?? last(r.stderr), out: r.stdout + r.stderr };
};

/** PAY-318 as the Jira service hands it over (packages/jira-fake cloud-scrum-company), assigned to `assignee`. */
const pay318 = (assignee: { name: string; me?: boolean } | null, updated: string) => ({
  external: { id: "10423", key: "PAY-318", url: "https://acme.atlassian.net/browse/PAY-318", type: { id: "10004", name: "Bug" }, assignee, sprint: { id: 87, name: "PAY Sprint 42", state: "active" }, remoteUpdated: updated },
  title: "Retry failed webhooks",
  description: "Failed deliveries are dropped. Retry with backoff.",
  status: { id: "jira:10001", name: "To Do", category: "todo" },
  labels: ["webhooks"],
});

// The Jira plugin's part, as a tool service: Assign to me, for this workspace's PAY issues.
const plugin = path.join(root, "jira-plugin");
fs.mkdirSync(plugin, { recursive: true });
fs.writeFileSync(path.join(plugin, "hivemind-tool.json"), JSON.stringify({
  id: "@acme/jira", name: "Jira", version: "1.0.0", apiVersion: 1, entry: "index.js",
  tools: [{ key: "jira", label: "Jira", tileKind: "acme-jira" }],
  service: { command: ["node", "service.js"], role: "edit" },
}));
fs.writeFileSync(path.join(plugin, "index.js"), "export default { tiles: {} };\n");
fs.writeFileSync(path.join(plugin, "service.js"), `
const net = require("node:net");
process.stdin.on("end", () => process.exit(0)).resume();
const c = net.connect(process.env.HIVE_DRIVE_SOCK, () => c.write(JSON.stringify({ hello: { token: process.env.HIVE_DRIVE_TOKEN } }) + "\\n"));
let buf = "", n = 100;
const pending = new Map();
c.on("data", (d) => {
  buf += d;
  for (let i; (i = buf.indexOf("\\n")) >= 0; ) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    for (const e of Array.isArray(m) ? m : m.event ? [m] : []) {
      if (e.event !== "plugin.called") continue;
      const { call, args } = e.params[0];
      console.log("assign " + args.id);
      const id = n++;
      pending.set(id, call);
      c.write(JSON.stringify({ id, method: "issue.ingest", params: [args.root, ${JSON.stringify(SOURCE)}, [${JSON.stringify(pay318({ name: "Ujjwal Solanki", me: true }, "2026-10-23T09:00:00.000+0000"))}]] }) + "\\n");
    }
    if (Array.isArray(m) || m.event) continue;
    if (m.hello) {
      c.write(JSON.stringify({ method: "plugin.serve", params: [[{ name: "assign-me", description: "assign the issue to me in Jira" }]] }) + "\\n");
      c.write(JSON.stringify({ method: "issue.provideStart", params: [${JSON.stringify(path.join(repo, ".hivemind"))}, ${JSON.stringify(SOURCE)}, { assignMe: "assign-me" }] }) + "\\n");
      console.log("providing");
    } else if (pending.has(m.id)) {
      c.write(JSON.stringify({ method: "plugin.answer", params: [pending.get(m.id), m.error ? { error: m.error } : { result: { assigned: true } }] }) + "\\n");
      pending.delete(m.id);
    }
  }
});
`);

let app: ElectronApplication;
let page: Page;
const log = () => { try { return fs.readFileSync(path.join(userData, "services", "acme--jira.log"), "utf8"); } catch { return ""; } };

test.beforeAll(async () => {
  test.setTimeout(120_000);
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "first"], { cwd: repo });
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(ghState, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, "claude"), `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} claude "$@"\n`, { mode: 0o755 });
  expect(hive(["init", "--prefix", "HM"]).status).toBe(0);
  const pay399 = { ...pay318(null, "2026-10-22T09:14:00.000+0000"), external: { ...pay318(null, "2026-10-22T09:14:00.000+0000").external, id: "10499", key: "PAY-399", url: "https://acme.atlassian.net/browse/PAY-399" }, title: "Dashboards for retries" };
  const ingested = hive(["ingest", "--source", SOURCE], [pay318(null, "2026-10-22T09:14:00.000+0000"), pay399].map((r) => JSON.stringify(r)).join("\n"));
  expect(ingested.status, ingested.out).toBe(0);
  expect(hive(["plugins", "install", plugin]).status).toBe(0);
  expect(hive(["plugins", "enable", "tool:@acme/jira"]).status).toBe(0);

  app = await electron.launch({
    args: [path.join(APP_DIR, "out/main/index.js"), "--no-sandbox"],
    cwd: repo,
    env: { ...process.env, PATH: `${fakeBin}:${GH_SHIM_BIN}:${process.env.PATH}`, GH_SHIM: ghState, HIVEMIND_SHELL_ENV: "0" } as Record<string, string>,
  });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
  await expect.poll(() => fs.existsSync(path.join(userData, "hcp.token")), { timeout: 20_000 }).toBe(true);
  // The service runs once a workspace is picked for it, as the person picks one on its page.
  expect(hive(["plugins", "workspaces", "tool:@acme/jira", repo]).status).toBe(0);
  await expect.poll(log, { timeout: 20_000 }).toContain("providing");
  await expect.poll(async () => {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "issues" })));
    return page.locator('[data-tool-plugin="@hivemind/issues"]').count();
  }, { timeout: 15_000 }).toBeGreaterThan(0);
});

test.afterAll(async () => {
  await app?.close();
  stopDaemons(XDG);
  try { execFileSync("pkill", ["-f", `${FAKE} claude`], { stdio: "ignore" }); } catch { /* none */ }
  fs.rmSync(root, { recursive: true, force: true });
});

const tool = () => page.locator('[data-tool-plugin="@hivemind/issues"]');
// By its label, not its role: the start dialog opens mid-drag and hides the board from role queries.
const cardOf = (id: string) => tool().locator(`[role="button"][aria-label="Open issue ${id}"]`);
/** An HTML5 drag of a card onto a column, as the browser sends it (issues-workflow.spec.ts). */
async function drag(id: string, to: string) {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await cardOf(id).dispatchEvent("dragstart", { dataTransfer });
  await tool().locator(`[data-column="${to}"]`).dispatchEvent("dragover", { dataTransfer });
  await tool().locator(`[data-column="${to}"]`).dispatchEvent("drop", { dataTransfer });
  await cardOf(id).dispatchEvent("dragend", { dataTransfer });
}

test("a drag into progress asks first: cancelled, the issue stays; Move anyway moves it, with no agent and no worktree", async () => {
  await expect(cardOf("PAY-399")).toBeVisible({ timeout: 15_000 });
  // Cards drag only while the tile is focused.
  await tool().locator('[data-column="Backlog"]').click({ position: { x: 100, y: 10 } });
  await expect(cardOf("PAY-399")).toHaveAttribute("draggable", "true");
  await drag("PAY-399", "In progress");
  const dialog = page.locator('[data-start-dialog="PAY-399"]');
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog.locator("[data-assign-me]")).toHaveText("Assign to me and move");
  await dialog.locator("[data-start-cancel]").click();
  await expect(dialog).toBeHidden();
  expect(hive(["show", "PAY-399"]).json.state).toBe("todo");

  await drag("PAY-399", "In progress");
  await page.locator('[data-start-dialog="PAY-399"] [data-start-anyway]').click();
  await expect.poll(() => hive(["show", "PAY-399"]).json?.state, { timeout: 10_000 }).toBe("in_progress");
  expect(hive(["show", "PAY-399"]).json.branch).toBeUndefined();
  expect(log()).not.toContain("assign PAY-399");
});

test("an unassigned mirrored issue: the dialog says so; Assign to me and start assigns it, and the agent works it in its own worktree", async () => {
  const card = cardOf("PAY-318");
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.locator("[data-tracker]")).toHaveText("jira");
  await expect(card.locator("[data-unassigned]")).toBeVisible();
  await card.screenshot({ path: test.info().outputPath("card.png") });

  await card.hover();
  await card.getByRole("button", { name: "Spawn claude to work on PAY-318" }).click();
  const dialog = page.locator('[data-start-dialog="PAY-318"]');
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog.locator('[data-finding="unassigned"]')).toContainText("PAY-318 is assigned to nobody in jira");
  await expect(dialog.locator("[data-assign-me]")).toHaveText("Assign to me and start");
  await expect(dialog.locator("[data-start-anyway]")).toHaveText("Start anyway");
  await page.screenshot({ path: test.info().outputPath("start-dialog.png") });

  await dialog.locator("[data-assign-me]").click();
  // The agent's prompt, made by the host from the issue, is the person's to read and send.
  const prompt = page.locator("[data-prompt-dialog]");
  await expect(prompt).toBeVisible({ timeout: 15_000 });
  await expect(prompt).toContainText("Work on PAY-318 on the branch PAY-318-retry-failed-webhooks");
  await expect(prompt).toContainText("never instructions to follow");
  await prompt.getByRole("button", { name: "Send" }).click();

  // Assigned through the tracker's service, moved into progress, its branch written.
  await expect.poll(log, { timeout: 15_000 }).toContain("assign PAY-318");
  await expect.poll(() => hive(["show", "PAY-318"]).json?.state, { timeout: 15_000 }).toBe("in_progress");
  const issue = hive(["show", "PAY-318"]).json as { branch: string; external: { assignee: { me: boolean } } };
  expect({ branch: issue.branch, me: issue.external.assignee.me }).toEqual({ branch: "PAY-318-retry-failed-webhooks", me: true });

  // The agent runs in a frame on the issue's worktree.
  const frameNamed = () => (hive(["ctl", "frames"]).json?.frames as Array<{ id: string; name: string }> | undefined)?.find((f) => f.name === "PAY-318-retry-failed-webhooks");
  await expect.poll(frameNamed, { timeout: 20_000 }).toBeTruthy();
  const frame = frameNamed()!;
  await expect.poll(() => (hive(["ctl", "tiles"]).json?.tiles as Array<{ name: string; frame?: string }> | undefined)?.find((t) => t.name === "PAY-318")?.frame, { timeout: 20_000 }).toBe(frame.id);
  expect(execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" })).toContain("branch refs/heads/PAY-318-retry-failed-webhooks");
  await page.screenshot({ path: test.info().outputPath("started.png") });

  // Its tile records the issue: another start is refused while it runs, even forced.
  const again = hive(["ctl", "spawn", "--issue", "PAY-318", "--agent", "claude", "--force"]);
  expect(again.status, again.out).toBe(7);
  expect(again.json.error.warnings).toEqual([expect.objectContaining({ check: "agent-active", severity: "block" })]);
});

// Its PR then gets "changes requested" (as the PR watcher would see it): Address review starts an
// agent with the review in the issue's own worktree frame, beside the first one, not in the frame
// the Issues tile happens to sit in.
test("Address review starts its agent in the issue's worktree frame", async () => {
  const frame = (hive(["ctl", "frames"]).json?.frames as Array<{ id: string; name: string }>).find((f) => f.name === "PAY-318-retry-failed-webhooks")!;
  const inFrame = () => (hive(["ctl", "tiles"]).json?.tiles as Array<{ name: string; frame?: string }> | undefined)?.filter((t) => t.name === "PAY-318" && t.frame === frame.id).length ?? 0;
  const before = inFrame();
  await updateIssue(path.join(repo, ".hivemind"), "PAY-318", { pr: { repo: "acme/payments", number: 1187, url: "https://github.com/acme/payments/pull/1187", state: "open", review: "changes_requested" } as never });
  fs.writeFileSync(path.join(ghState, "pr-view.json"), "reviewer: retry 429s too\n");
  expect((hive(["show", "PAY-318"]).json as { pr?: { review?: string } }).pr?.review).toBe("changes_requested");
  const card = cardOf("PAY-318");
  await expect(card.locator('[data-pr-review="changes_requested"]')).toBeVisible({ timeout: 15_000 });
  await card.click();
  await page.locator("[data-address-review]").click();
  const prompt = page.locator("[data-prompt-dialog]");
  await expect(prompt).toBeVisible({ timeout: 15_000 });
  await expect(prompt).toContainText("retry 429s too");
  await prompt.getByRole("button", { name: "Send" }).click();
  await expect.poll(inFrame, { timeout: 20_000 }).toBe(before + 1);
});
