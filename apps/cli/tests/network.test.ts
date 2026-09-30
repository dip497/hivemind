// `hive network` (R16): this computer's network as the app keeps it, verified by hive-net
// (crates/hive-net's build): the local network until another is chosen; hivemind's servers, or a
// network from its link, from then on; an update to the network in use signed by someone else is
// refused and changes nothing.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hive } from "./helpers.js";
import { idOf, newSeed, signWith, type Seed } from "@hivemind/workspace-host/identity";

const HIVE_NET = path.resolve(import.meta.dir, "../../../crates/hive-net/target/debug/hive-net");
const built = fs.existsSync(HIVE_NET);

function link(name: string, admin: Seed): string {
  const text = JSON.stringify({ v: 1, name, relays: [{ url: "http://127.0.0.1:9" }], admin: idOf(admin), local: { mdns: true } });
  const signature = Buffer.from(signWith(admin, new Uint8Array(Buffer.concat([Buffer.from("hive/network-profile/1\n"), Buffer.from(text)])))).toString("hex");
  return `hivemind://network/${Buffer.from(JSON.stringify({ profile: text, signature })).toString("base64url")}`;
}

describe("hive network", () => {
  test.skipIf(!built)("the local network until another is chosen; one from its link from then on; an update from someone else refused", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hive-network-"));
    const env = { HIVEMIND_APP_DATA: tmp, HIVEMIND_HIVE_NET: HIVE_NET };
    const data = <T>(r: ReturnType<typeof hive>) => (r.json as { data: T }).data;

    let r = hive(["network", "show", "--json"], { env });
    expect(data<{ builtin: string }>(r).builtin).toBe("local");
    r = hive(["network", "use", "hosted", "--json"], { env });
    expect(data<{ profile: { name: string } }>(r).profile.name).toBe("hivemind");
    expect(fs.readFileSync(path.join(tmp, "network", "profile"), "utf8").trim()).toBe("hosted");

    const admin = newSeed();
    r = hive(["network", "use", link("Example Corp", admin), "--json"], { env });
    expect(data<{ admin: string; profile: { name: string } }>(r)).toMatchObject({ admin: idOf(admin), profile: { name: "Example Corp" } });
    r = hive(["network", "show"], { env });
    expect(r.stdout).toContain(`Example Corp — signed by ${idOf(admin)}`);
    expect(r.stdout).toContain("relay   http://127.0.0.1:9");

    r = hive(["network", "use", link("Example Corp", newSeed()), "--json"], { env });
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ ok: false, code: "refused" });
    expect((r.json as { error: string }).error).toContain("not signed by its admin");
    r = hive(["network", "show", "--json"], { env });
    expect(data<{ admin: string }>(r).admin).toBe(idOf(admin));
    fs.rmSync(tmp, { recursive: true, force: true });
  }, 60_000);
});
