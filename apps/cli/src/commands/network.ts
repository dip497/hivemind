/**
 * `hive network` (R16): this computer's network, as Settings → Network shows it. The profile is the
 * app's (`network/profile` in its data folder), verified by hive-net; a running app starts its
 * network again when it changes.
 *
 *   hive network show                 which network, who signed it, its servers
 *   hive network use <local|hosted|link|file>   use another; an update to the network in use
 *                                     must be signed by its admin
 *   hive network doctor               whether its relays answer this computer
 *   hive network enrol-link [--data <dir>]   on the network's server: a link that puts one more
 *                                     device on it, signed with the admin key kept in its data
 */
import { defineCommand } from "citty";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { NetworkProfiles, type NetworkProfile } from "@hivemind/workspace-host/network-profile";
import { err, ok } from "../format.js";
import { appData, hiveNetBin } from "../app-data.js";
import { EXIT } from "../hcp.js";
import { duration } from "./share.js";

function profiles(ctx: { json: boolean }): NetworkProfiles | null {
  const bin = hiveNetBin();
  if (!bin) {
    err(ctx, "not_installed", "hive-net is not installed here: reinstall hivemind (install.sh puts it beside hive)");
    return null;
  }
  return new NetworkProfiles({ dir: path.join(appData(), "network"), bin, identity: path.join(appData(), "identity") });
}

function describe(net: NetworkProfile): string {
  const p = net.profile;
  const lines = [`${p.name}${net.builtin ? ` (built in: ${net.builtin})` : ` — signed by ${net.admin}`}`];
  if (!p.relays.length) lines.push("  no servers: devices find each other on this network, and nothing leaves it");
  for (const r of p.relays) lines.push(`  relay   ${r.url}`);
  if (p.lookup) lines.push(`  lookup  ${p.lookup}`);
  if (p.access) lines.push(`  access  ${p.access.url} (${p.access.policy})`);
  if (p.push) lines.push(`  push    ${p.push.url} (${p.push.kinds.join(", ")})`);
  return lines.join("\n");
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const showCmd = defineCommand({
  meta: { name: "show", description: "Which network this computer is on, who signed it, and its servers" },
  args: { json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const p = profiles(ctx);
    if (!p) return;
    try {
      const net = await p.active();
      return ok(ctx, net, () => describe(net));
    } catch (e) { return err(ctx, "invalid_profile", message(e)); }
  },
});

const useCmd = defineCommand({
  meta: { name: "use", description: "Use another network: local, hosted, a network link or a signed profile's file" },
  args: { network: { type: "positional", required: true }, json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const p = profiles(ctx);
    if (!p) return;
    try {
      const net = await p.use(String(args.network));
      return ok(ctx, net, () => `now on ${describe(net)}\nadmission: ${net.admission}\n(a running app starts its network again)`);
    } catch (e) { return err(ctx, "refused", message(e)); }
  },
});

const doctorCmd = defineCommand({
  meta: { name: "doctor", description: "Whether this network's relays answer this computer" },
  args: { json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const p = profiles(ctx);
    if (!p) return;
    try {
      const health = await p.health();
      const down = health.relays.filter((r) => !r.ok);
      if (down.length) return err(ctx, "unreachable", `no answer from ${down.map((r) => r.url).join(", ")}`);
      return ok(ctx, health, () => (health.relays.length ? health.relays.map((r) => `✓ ${r.url}`).join("\n") : "no servers to check: this is the local network"));
    } catch (e) { return err(ctx, "failed", message(e)); }
  },
});

const enrolLinkCmd = defineCommand({
  meta: { name: "enrol-link", description: "On the network's server: a link that puts one more device on it" },
  args: {
    data: { type: "string", description: "the server's data folder, as `hive-net serve --data` has it (default: /var/lib/hive-net)" },
    uses: { type: "string", description: "how many devices it enrols (default: 1)" },
    expires: { type: "string", description: "how long it works: 12h, 7d … (default: 7d)" },
    json: { type: "boolean" },
  },
  run({ args }) {
    const ctx = { json: !!args.json };
    const bin = hiveNetBin();
    if (!bin) return err(ctx, "not_installed", "hive-net is not installed here: reinstall hivemind (install.sh puts it beside hive)");
    const data = path.resolve(String(args.data ?? "/var/lib/hive-net"));
    const profile = path.join(data, "network.json");
    const admin = path.join(data, "admin.key");
    for (const f of [profile, admin]) {
      if (!fs.existsSync(f)) return err(ctx, "usage", `no ${path.basename(f)} in ${data}: point --data at the folder \`hive-net serve --data\` keeps`, EXIT.usage);
    }
    const uses = args.uses === undefined ? 1 : Number(args.uses);
    if (!Number.isSafeInteger(uses) || uses < 1) return err(ctx, "usage", "--uses is a whole number from 1", EXIT.usage);
    const ms = duration(String(args.expires ?? "7d"));
    if (!ms) return err(ctx, "usage", "--expires is a length of time: 12h, 7d", EXIT.usage);
    const r = spawnSync(bin, ["access", "enrol-link", profile, "--admin", admin, "--uses", String(uses), "--expires-in", String(ms / 1000)], { encoding: "utf8" });
    if (r.status !== 0) return err(ctx, "refused", (r.stderr || r.error?.message || "hive-net failed").trim());
    const link = r.stdout.trim();
    return ok(ctx, { link, uses, expires: Date.now() + ms }, () => `${link}\nenrols ${uses === 1 ? "one device" : `${uses} devices`} for ${args.expires ?? "7d"}: \`hive network use <link>\` there, or Settings → Network → Change…`);
  },
});

export const networkCmd = defineCommand({
  meta: { name: "network", description: "This computer's network: show, use another, check its servers" },
  subCommands: { show: showCmd, use: useCmd, doctor: doctorCmd, "enrol-link": enrolLinkCmd },
});
