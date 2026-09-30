// This device's network (network-profile.ts), with the real hive-net (crates/hive-net, built with
// `cargo build`): none kept is the local network; a built-in one, or a signed one from its link,
// is used from then on; an update to that network signed by someone else, or anything that is not
// a profile, is refused and changes nothing.
import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NetworkProfiles } from "../src/network-profile.ts";
import { idOf, newSeed, signWith, type Seed } from "../src/identity.ts";

const BIN = path.join(import.meta.dir, "../../../crates/hive-net/target/debug/hive-net");
const built = fs.existsSync(BIN);
if (!built) console.warn("network-profile.test.ts skipped: build the daemon first (cargo build in crates/hive-net)");

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "net-profile-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A profile for the network `name`, signed by `admin`, as its link. */
function link(name: string, admin: Seed, signer: Seed = admin): string {
  const text = JSON.stringify({ v: 1, name, relays: [], admin: idOf(admin), local: { mdns: true } });
  const signature = Buffer.from(signWith(signer, new Uint8Array(Buffer.concat([Buffer.from("hive/network-profile/1\n"), Buffer.from(text)])))).toString("hex");
  return `hivemind://network/${Buffer.from(JSON.stringify({ profile: text, signature })).toString("base64url")}`;
}

test.skipIf(!built)("none kept is the local network; a built-in one, or a signed one from its link, is used from then on", async () => {
  const profiles = new NetworkProfiles({ dir: path.join(dir, "network"), bin: BIN });
  expect((await profiles.active()).builtin).toBe("local");
  expect(profiles.arg()).toBe("local");

  expect((await profiles.use("hosted")).profile.name).toBe("hivemind");
  expect((await profiles.active()).builtin).toBe("hosted");

  const admin = newSeed();
  const used = await profiles.use(link("Example Corp", admin));
  expect([used.builtin, used.admin, used.profile.name]).toEqual([null, idOf(admin), "Example Corp"]);
  expect((await new NetworkProfiles({ dir: path.join(dir, "network"), bin: BIN }).active()).profile.name).toBe("Example Corp");
  fs.writeFileSync(path.join(dir, "device.key"), `${Buffer.from(newSeed()).toString("hex")}\n`);
  expect(await profiles.health(dir)).toEqual({ relays: [], mdns: true });
});

test.skipIf(!built)("an update signed by someone else, or what is not a profile, is refused and changes nothing", async () => {
  const profiles = new NetworkProfiles({ dir: path.join(dir, "network"), bin: BIN });
  const admin = newSeed();
  await profiles.use(link("Example Corp", admin));
  const kept = fs.readFileSync(profiles.file, "utf8");

  await expect(profiles.use(link("Example Corp", newSeed()))).rejects.toThrow("not signed by its admin");
  // Signed by a key other than the admin it names.
  await expect(profiles.use(link("Elsewhere", newSeed(), newSeed()))).rejects.toThrow("not signed by its admin");
  await expect(profiles.use("{\"profile\": \"{}\", \"signature\": \"00\"}")).rejects.toThrow();
  expect(fs.readFileSync(profiles.file, "utf8")).toBe(kept);
  expect(fs.readdirSync(path.join(dir, "network"))).toEqual(["profile"]);
  // Another network, or the local one, is this person's to choose.
  expect((await profiles.use(link("Elsewhere", newSeed()))).profile.name).toBe("Elsewhere");
  expect((await profiles.use("local")).builtin).toBe("local");
});
