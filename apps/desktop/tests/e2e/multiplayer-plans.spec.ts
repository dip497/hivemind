// Plans agents hand off, answered together (M2, design §4.2 D 6), with two app instances: an
// agent's plan opens beside it in the host's window and in the guest's; a guest who may not drive
// agents reads it and cannot answer it; the host answers, the agent gets that answer, and the guest
// is told who gave it. Given *Can drive agents*, the guest answers the next plan: the agent gets
// their answer, and the host is told.
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { hiveNetBuilt, sharedWorkspace, tiles } from "./helpers/multiplayer";

let root: string;
const apps: ElectronApplication[] = [];
test.beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-plans-")); });
test.afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
});

const review = (w: Page) => w.locator(".react-flow__node-planReview");
/** A person answers the plan in front of them: the tile takes the first click, to select it. */
async function approve(w: Page): Promise<void> {
  await review(w).click();
  await review(w).getByRole("button", { name: "Approve plan" }).click();
}

test("a plan opens beside its agent for the host and the guest; the host answers, then a guest who drives agents does, and each is told who answered", async () => {
  test.skip(!hiveNetBuilt(), "build hive-net first: cargo build in crates/hive-net");
  const { host, guest, repo } = await sharedWorkspace(root, apps, "terminals", { names: { host: "Adarsh", guest: "Priya" } });
  const userData = await apps[0]!.evaluate(({ app }) => app.getPath("userData"));
  const agent = (await tiles(host)).find((id) => id.startsWith("tile-shell"))!;
  /** The agent hands off `plan`, as its hook does, and waits for the answer. */
  const handOff = (plan: string) => new Promise<{ decision: string }>((resolve, reject) => {
    const c = net.connect(path.join(userData, "plan-bridge.sock"));
    let got = "";
    c.on("connect", () => c.write(`${JSON.stringify({ tileId: `hm:${agent}`, plan, cwd: repo })}\n`));
    c.on("data", (d) => { got += String(d); if (got.includes("\n")) { resolve(JSON.parse(got.slice(0, got.indexOf("\n")))); c.end(); } });
    c.on("error", reject);
  });

  // The guest may use terminals, not drive agents: they read the plan and cannot answer it.
  const first = handOff("# First plan\n\n1. Read the code");
  await expect(review(host)).toHaveCount(1, { timeout: 10_000 });
  await expect(review(guest)).toHaveCount(1, { timeout: 10_000 });
  await expect(review(guest).locator("[data-plan-read-only]")).toBeVisible();
  await expect(review(guest).getByRole("button", { name: "Approve plan" })).toHaveCount(0);
  // The host approves: the agent gets it, and the guest is told who answered.
  await approve(host);
  expect((await first).decision).toBe("allow");
  await expect(review(guest)).toHaveCount(0);
  await expect(guest.locator("[data-sonner-toast]", { hasText: "Adarsh approved the plan" })).toBeVisible();

  // Given Can drive agents, the guest answers the next one; the host is told.
  const me = await guest.evaluate(() => window.hive.identity());
  await host.evaluate(([r, p]) => window.hive.setRole(r, p, "agents"), [repo, me.personId] as const);
  await expect(guest.locator("[data-shared-banner]")).toHaveAttribute("data-access", "agents", { timeout: 10_000 });
  const second = handOff("# Second plan\n\n1. Change the code");
  await expect(review(guest)).toHaveCount(1, { timeout: 10_000 });
  await approve(guest);
  expect((await second).decision).toBe("allow");
  await expect(review(host)).toHaveCount(0);
  await expect(host.locator("[data-sonner-toast]", { hasText: "Priya approved the plan" })).toBeVisible();
});
