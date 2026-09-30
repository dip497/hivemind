// Inviting across networks (M1 step 5, R16, design §13.3 D): a host on a network whose relays admit
// only the devices it is told to shares a workspace; the invite carries the network's relay, its
// access service and a voucher the host signed; a guest on their own local network joins with it:
// their device is let onto the host's network, the host vouches for it once they are let in (for
// weeks, not only as long as the invite), and they work in the workspace.
import { test, expect, type ElectronApplication } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HIVE_NET, hiveNetBuilt, join, person, share, tiles } from "./helpers/multiplayer";

let root: string;
const apps: ElectronApplication[] = [];
let server: ChildProcess | undefined;
test.beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-networks-")); });
test.afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => {});
  server?.kill();
  server = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

/** A closed network: a relay and its access service, run by `admin.key`; its link, with an
 *  enrolment voucher for one device. */
async function closedNetwork(): Promise<{ relay: string; access: string; link: string; data: string }> {
  const admin = path.join(root, "admin.key");
  fs.writeFileSync(admin, `${"cd".repeat(32)}\n`);
  const voucher = (kind: string) => execFileSync(HIVE_NET, ["access", "voucher", "--kind", kind, "--admin", admin], { encoding: "utf8" }).trim();
  const adminId = (JSON.parse(voucher("enrol")) as { by: string }).by;
  const data = path.join(root, "network");
  server = spawn(HIVE_NET, ["serve", "--relay", "--access", "--admin-id", adminId, "--policy", "closed", "--data", data, "--bind", "127.0.0.1:0", "--access-bind", "127.0.0.1:0"], { stdio: ["ignore", "pipe", "ignore"] });
  const lines: string[] = [];
  await new Promise<void>((resolve) => server!.stdout!.on("data", (d: Buffer) => { lines.push(...d.toString().trim().split("\n")); if (lines.length >= 2) resolve(); }));
  const relay = lines[0]!.replace("relay serving on ", "");
  const access = lines[1]!.replace("access serving on ", "");
  const text = path.join(root, "profile.json");
  fs.writeFileSync(text, JSON.stringify({ v: 1, name: "Example Corp", relays: [{ url: relay }], access: { url: access, policy: "closed" }, admin: adminId, local: { mdns: true } }));
  const signed = JSON.parse(execFileSync(HIVE_NET, ["profile", "sign", text, "--admin", admin], { encoding: "utf8" })) as object;
  const link = `hivemind://network/${Buffer.from(JSON.stringify({ ...signed, enrol: JSON.parse(voucher("enrol")) })).toString("base64url")}`;
  return { relay, access, link, data };
}

test("a guest on another network joins with the invite's voucher, is vouched for once let in, and works in the workspace", async () => {
  test.skip(!hiveNetBuilt(), "build hive-net first: cargo build in crates/hive-net");
  const net = await closedNetwork();
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

  // The invite names the network's relay and access service, and carries the host's voucher.
  const link = await share(host, "edit");
  const carried = JSON.parse(Buffer.from(link.split("#")[1]!, "base64url").toString("utf8")) as { r: string; x: string; v: { kind: string; by: string } };
  expect(carried.r.replace(/\/$/, "")).toBe(net.relay.replace(/\/$/, ""));
  expect(carried.x).toBe(net.access);
  expect(carried.v.kind).toBe("visit");

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
