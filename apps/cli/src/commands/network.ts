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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NetworkProfiles, type NetworkProfile } from "@hivemind/workspace-host/network-profile";
import { err, ok } from "../format.js";
import { configDir, win32UserDataDir } from "../hcp.js";

/** The app's data folder, where its keys and network are kept (`HIVEMIND_APP_DATA` names another). */
function appData(): string {
  const named = process.env.HIVEMIND_APP_DATA;
  if (named) return named;
  if (process.platform === "win32") return win32UserDataDir() ?? path.join(os.homedir(), "AppData", "Roaming", "hivemind");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "hivemind");
  return path.join(configDir(), "hivemind");
}

/** hive-net: named by HIVEMIND_HIVE_NET, else where the installers put it, else on PATH. */
function hiveNet(): string | null {
  const exe = process.platform === "win32" ? "hive-net.exe" : "hive-net";
  const candidates = [
    process.env.HIVEMIND_HIVE_NET,
    path.join(os.homedir(), ".hivemind-app", exe),
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((d) => path.join(d, exe)),
  ];
  return candidates.find((c): c is string => !!c && fs.existsSync(c)) ?? null;
}

function profiles(ctx: { json: boolean }): NetworkProfiles | null {
  const bin = hiveNet();
  if (!bin) {
    err(ctx, "not_installed", "hive-net is not installed here: reinstall hivemind (install.sh puts it beside hive)");
    return null;
  }
  return new NetworkProfiles({ dir: path.join(appData(), "network"), bin });
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
      return ok(ctx, net, () => `now on ${describe(net)}\n(a running app starts its network again)`);
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
      const health = await p.health(path.join(appData(), "identity"));
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
