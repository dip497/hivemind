// A guest driving a host agent keeps receiving the host's document after its terminal starts, even
// while the agent prints more than the link has room for.
import { test, expect, type ElectronApplication } from "@playwright/test";
import { execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seedAgents } from "./helpers/agents";
import { hiveNetBuilt, join, ownNetwork, person, share, tiles } from "./helpers/multiplayer";
import { stopDaemons } from "./helpers/daemons";

let root: string;
const apps: ElectronApplication[] = [];
const procs: ChildProcess[] = [];
test.beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-sync-freeze-")); });
test.afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => {});
  for (const p of procs.splice(0)) p.kill();
  stopDaemons(root);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a guest opening Claude keeps receiving tiles and roles over a relay", async () => {
  test.skip(!hiveNetBuilt(), "build hive-net first: cargo build in crates/hive-net");
  test.setTimeout(180_000);
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\n[ \"$1\" = --version ] && { echo '2.0.0 (Claude Code)'; exit 0; }\nfor i in 1 2 3 4 5 6 7 8 9 10; do head -c 4000000 /dev/zero | tr '\\0' x; sleep 1; done\nexec sleep 120\n", { mode: 0o755 });
  for (const profile of ["host", "guest"]) seedAgents(path.join(root, profile), ["claude"]);
  const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const net = await ownNetwork(root, procs);
  const repo = path.join(root, "api");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const host = await person(root, "host", repo, apps, env);
  await host.evaluate((link) => window.hive.useNetwork(link), net.link);
  for (let i = 0; i < 3; i++) await host.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await expect.poll(async () => (await tiles(host)).filter((id) => id?.startsWith("tile-shell")).length).toBe(3);

  const elsewhere = path.join(root, "elsewhere");
  fs.mkdirSync(elsewhere);
  const guest = await person(root, "guest", elsewhere, apps, env);
  // Carry only the relay to reproduce a guest outside the host's direct-address network.
  const invite = await share(host, "terminals");
  const [base, fragment] = invite.split("#");
  const carried = JSON.parse(Buffer.from(fragment!, "base64url").toString("utf8")) as Record<string, unknown>;
  const viaRelay = `${base}#${Buffer.from(JSON.stringify({ ...carried, a: [] })).toString("base64url")}`;
  await join(guest, host, viaRelay);
  await guest.locator("[data-join-open]").click();
  await expect.poll(() => tiles(guest), { timeout: 15_000 }).toEqual(await tiles(host));

  const me = await guest.evaluate(() => window.hive.identity());
  await host.evaluate(([r, p]) => window.hive.setRole(r, p, "agents"), [repo, me.personId] as const);
  await expect(guest.locator("[data-shared-banner]")).toHaveAttribute("data-access", "agents", { timeout: 15_000 });
  const frame = (await guest.locator(".react-flow__node-frame").first().getAttribute("data-id"))!;
  await guest.evaluate((id) => window.dispatchEvent(new CustomEvent("hivemind:frame-open", { detail: { frameId: id, kind: "claude" } })), frame);
  await expect.poll(async () => (await tiles(host)).filter((id) => id?.startsWith("tile-claude")).length, { timeout: 20_000 }).toBe(1);
  await expect.poll(() => tiles(guest), { timeout: 15_000 }).toEqual(await tiles(host));

  for (let i = 0; i < 3; i++) {
    const had = (await tiles(host)).length;
    await host.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
    await expect.poll(async () => (await tiles(host)).length).toBe(had + 1);
    await expect.poll(() => tiles(guest), { timeout: 15_000 }).toEqual(await tiles(host));
  }
  await host.evaluate(([r, p]) => window.hive.setRole(r, p, "view"), [repo, me.personId] as const);
  await expect(guest.locator("[data-shared-banner]")).toHaveAttribute("data-access", "view", { timeout: 15_000 });
  await expect.poll(() => tiles(guest), { timeout: 15_000 }).toEqual(await tiles(host));
});
