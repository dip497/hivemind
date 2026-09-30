/**
 * `hive network` (R16): this computer's network, as Settings → Network shows it. The profile is the
 * app's (`network/profile` in its data folder), verified by hive-net; a running app starts its
 * network again when it changes.
 *
 *   hive network show                 which network, who signed it, its servers
 *   hive network use <local|hosted|link|file>   use another; an update to the network in use
 *                                     must be signed by its admin
 *   hive network doctor               whether its relays answer this computer
 */
import { defineCommand } from "citty";
import path from "node:path";
import { NetworkProfiles, type NetworkProfile } from "@hivemind/workspace-host/network-profile";
import { err, ok } from "../format.js";
import { appData, hiveNetBin } from "../app-data.js";

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

export const networkCmd = defineCommand({
  meta: { name: "network", description: "This computer's network: show, use another, check its servers" },
  subCommands: { show: showCmd, use: useCmd, doctor: doctorCmd },
});
