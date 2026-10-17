// Inviting across networks (M1 step 5, R16, design §13.3 D): a host on a network whose relays admit
// only the devices it is told to shares a workspace; the invite carries the network's relay, its
// access service and a voucher the host signed, and the workspace's key and the network's lookup
// server, where the host has said it hosts the workspace (M3, §5.8); a guest on their own local
// network joins with it: their device is let onto the host's network, the host vouches for it once
// they are let in (for weeks, not only as long as the invite), and they work in the workspace.
import { test, expect, type ElectronApplication } from "@playwright/test";
import { execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HIVE_NET, hiveNetBuilt, join, ownNetwork, person, share, tiles } from "./helpers/multiplayer";

let root: string;
const apps: ElectronApplication[] = [];
/** The network's server, stopped after each test. */
const procs: ChildProcess[] = [];
test.beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-networks-")); });
test.afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => {});
  for (const p of procs.splice(0)) p.kill();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a guest on another network joins with the invite's voucher, is vouched for once let in, and works in the workspace", async () => {
  test.skip(!hiveNetBuilt(), "build hive-net first: cargo build in crates/hive-net");
  const net = await ownNetwork(root, procs);
  const repo = path.join(root, "api");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const host = await person(root, "host", repo, apps);
  // The host's computer joins the network with its admin's link, and is enrolled on it.
  expect((await host.evaluate((l) => window.hive.useNetwork(l), net.link) as { admission: string }).admission).toBe("enrolled");
  await host.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await expect.poll(async () => (await tiles(host)).length).toBeGreaterThan(0);

  const guestDir = path.join(root, "elsewhere");
  fs.mkdirSync(guestDir);
  const guest = await person(root, "guest", guestDir, apps);
  const me = await guest.evaluate(() => window.hive.identity());
  const allowed = async () => (await fetch(`${net.access}/allowed/${me.deviceId}`)).text();
  expect(await allowed()).toBe("false");

  // The invite names the network's relay and access service, and carries the host's voucher; and
  // the workspace's key and the lookup server, where the host says it hosts the workspace.
  const link = await share(host, "edit");
  const carried = JSON.parse(Buffer.from(link.split("#")[1]!, "base64url").toString("utf8")) as { r: string; x: string; v: { kind: string; by: string }; k: string; l: string };
  expect(carried.r.replace(/\/$/, "")).toBe(net.relay.replace(/\/$/, ""));
  expect(carried.x).toBe(net.access);
  expect(carried.v.kind).toBe("visit");
  expect(carried.l).toBe(net.lookup);
  const hostId = (await host.evaluate(() => window.hive.identity())).deviceId;
  const record = () => {
    try { return JSON.parse(execFileSync(HIVE_NET, ["host-record", "resolve", carried.k, "--lookup", carried.l], { encoding: "utf8" })) as { host: string | null }; } catch { return { host: null }; }
  };
  await expect.poll(() => record().host, { timeout: 15_000 }).toBe(hostId);

  await join(guest, host, link);
  expect(await allowed()).toBe("true");
  const kept = () => JSON.parse(fs.readFileSync(path.join(net.data, "access.json"), "utf8")) as { visiting: Record<string, { until: number }>; redeemed: Record<string, number> };
  // The guest's device got onto the network with the invite's voucher, before asking to join.
  expect(kept().redeemed[(carried.v as unknown as { nonce: string }).nonce]).toBe(1);
  // Let in, the guest is vouched for by the host for weeks, not only for as long as the invite.
  await expect.poll(() => (kept().visiting[me.deviceId]?.until ?? 0) - Date.now() > 20 * 24 * 3600_000, { timeout: 15_000 }).toBe(true);

  await guest.locator("[data-join-open]").click();
  await expect.poll(() => tiles(guest), { timeout: 15_000 }).toEqual(await tiles(host));
});
