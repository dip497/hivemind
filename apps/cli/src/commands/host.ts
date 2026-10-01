/**
 * `hive host` (R14; design §5.7): this machine as an always-on host, with no desktop. It serves the
 * workspaces in the app's data folder here to the devices their access lists let in, over
 * hive-net, and runs their terminals in this machine's PTY daemon, so agents keep working whoever
 * is connected, and after the host itself restarts.
 *
 *   hive host run       serve until stopped (what a service runs)
 *   hive host status    whether it runs, as which device, where it is reached, its workspaces
 *   hive host stop      stop serving; the terminals keep running in the daemon
 *   hive host pair      make it one of your devices (spec/pairing.md): print a code, QR and link
 *                       for your app to enter, or `hive host pair <words or link>` to enter one
 *                       it shows
 *   hive host add <dir> serve a folder on this machine as one of its workspaces
 */
import { defineCommand } from "citty";
import { renderUnicodeCompact } from "uqr";
import net from "node:net";
import path from "node:path";
import { applyShellEnvToProcess } from "@hivemind/agent-host/shell-env";
import { startHeadlessHost, type HeadlessHost, type HeadlessHostOptions } from "@hivemind/host/headless";
import type { PairedDevice } from "@hivemind/workspace-host/devices";
import { appData, hiveNetBin } from "../app-data.js";
import { err, ok } from "../format.js";
import { EXIT } from "../hcp.js";
import { appRunning, askHost, controlSocket, HostNotRunning, serveControl } from "../host-control.js";
import { defaultSocket } from "../pty-client.js";
import { checkSocketPath, daemonUnsupported, ensureDaemon } from "./daemon.js";

/** What `hive host status` reports of a running host. */
interface HostStatus {
  running: true;
  pid: number;
  device: string;
  person: string;
  network: { id: string; addrs: string[]; relay: string | null } | null;
  workspaces: Array<{ repo: string; workspace: string | null }>;
  /** The person's other devices it is paired with. */
  devices: Array<Pick<PairedDevice, "device" | "name" | "kind">>;
}

function statusOf(host: HeadlessHost): HostStatus {
  const where = host.where();
  return {
    running: true,
    pid: process.pid,
    device: host.device,
    person: host.person,
    network: where && { id: where.id, addrs: where.addrs, relay: where.relay },
    workspaces: host.workspaces(),
    devices: host.devices().map((d) => ({ device: d.device, name: d.name, kind: d.kind })),
  };
}

/** A device, as the person reads it. */
const named = (d: Pick<PairedDevice, "name" | "kind">) => `${d.name} (${d.kind === "app" ? "the app" : "a host"})`;
/** How long a person has to enter a code; the host's offer expires first. */
const PAIR_WAIT_MS = 6 * 60_000;

const connectTo = (sock: string): Promise<net.Socket> => new Promise((resolve, reject) => {
  const s = net.connect(sock);
  s.once("error", reject);
  s.once("connect", () => { s.removeListener("error", reject); resolve(s); });
});

const runCmd = defineCommand({
  meta: { name: "run", description: "Serve this machine's workspaces until stopped (what a service runs)" },
  args: { json: { type: "boolean", description: "report the start as JSON" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const dir = appData();
    const app = appRunning(dir);
    if (app) return err(ctx, "app_running", `the hivemind app is running here (pid ${app}) and serves this machine's workspaces itself`, EXIT.unavailable);
    const daemonSock = defaultSocket();
    const bad = checkSocketPath(daemonSock) ?? daemonUnsupported();
    if (bad) return err(ctx, "daemon_unsupported", bad, EXIT.unavailable);

    let host: HeadlessHost | null = null;
    let stopping: Promise<void> | null = null;
    /** The device that entered the code offered here, once it has. */
    let pairing: Promise<PairedDevice> | null = null;
    const opts: HeadlessHostOptions = {
      dir,
      daemon: async () => { await ensureDaemon(daemonSock); return connectTo(daemonSock); },
      hiveNet: hiveNetBin(),
      onWarn: (m) => process.stderr.write(`[host] ${m}\n`),
    };
    const running = (): HeadlessHost => { if (!host) throw new Error("hive host is starting"); return host; };
    // Paired, this host is someone else: it starts again as them (once its answer has gone out).
    const startAgain = async (paired: PairedDevice): Promise<PairedDevice> => {
      await new Promise((r) => setTimeout(r, 500));
      const was = host;
      host = null;
      await was?.stop();
      host = await startHeadlessHost(opts);
      process.stdout.write(`hive host: paired with ${named(paired)}; serving as its person\n`);
      return paired;
    };
    const control = await serveControl(controlSocket(dir), {
      status: () => statusOf(running()),
      stop: () => { setTimeout(() => void shutdown(), 0); return { stopping: true }; },
      "pair-offer": () => {
        const offer = running().offerPairing();
        pairing = offer.paired.then(startAgain);
        pairing.catch(() => { /* expired: told to whoever waits */ });
        return { code: offer.code, link: offer.link, expires: offer.expires };
      },
      "pair-wait": async () => {
        if (!pairing) throw new Error("no code is offered here: `hive host pair` offers one");
        return pairing;
      },
      "pair-enter": async (a) => startAgain(await running().enterPairing(String(a.text ?? ""))),
      add: (a) => running().add(String(a.path ?? "")),
    });
    if (control.claim === "taken") return err(ctx, "already_running", "hive host is already running here (`hive host status`)", EXIT.unavailable);
    const shutdown = (): Promise<void> => (stopping ??= (async () => {
      control.server.close();
      await host?.stop();
      process.exit(0);
    })());
    process.on("SIGTERM", () => void shutdown());
    process.on("SIGINT", () => void shutdown());

    try {
      // A service starts with a bare environment: agents need the login shell's PATH and tokens,
      // and the daemon started below passes on what this process has.
      await applyShellEnvToProcess();
      host = await startHeadlessHost(opts);
    } catch (e) {
      control.server.close();
      return err(ctx, "host_start_failed", e instanceof Error ? e.message : String(e));
    }
    const status = statusOf(host);
    ok(ctx, status, () => [
      `hive host: serving ${status.workspaces.length} workspace(s) as ${status.device.slice(0, 12)}…`,
      status.network ? `  on the network: ${status.network.addrs.join(", ") || "no direct address"}${status.network.relay ? ` · relay ${status.network.relay}` : ""}` : "  not on the network: hive-net is not installed here (install.sh puts it beside hive)",
    ].join("\n"));
    return new Promise<never>(() => { /* serves until stopped */ });
  },
});

const statusCmd = defineCommand({
  meta: { name: "status", description: "Whether hive host runs here, as which device, where it is reached, its workspaces" },
  args: { json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const sock = controlSocket(appData());
    let status: HostStatus;
    try {
      status = (await askHost(sock, "status")) as HostStatus;
    } catch (e) {
      if (e instanceof HostNotRunning) return ok(ctx, { running: false }, () => e.message);
      return err(ctx, "host_unavailable", e instanceof Error ? e.message : String(e), EXIT.unavailable);
    }
    return ok(ctx, status, () => [
      `hive host running (pid ${status.pid})`,
      `  device      ${status.device}`,
      `  person      ${status.person}`,
      `  network     ${status.network ? `${status.network.addrs.join(", ") || "no direct address"}${status.network.relay ? ` · relay ${status.network.relay}` : ""}` : "off (hive-net is not installed here)"}`,
      `  workspaces  ${status.workspaces.length}`,
      ...status.workspaces.map((w) => `    ${w.repo}`),
      `  paired with ${status.devices.length ? status.devices.map(named).join(", ") : "no device yet (`hive host pair`)"}`,
    ].join("\n"));
  },
});

const pairCmd = defineCommand({
  meta: { name: "pair", description: "Make this host one of your devices: print a code for your app, or enter the code it shows" },
  args: {
    link: { type: "positional", required: false, description: "the six words (quoted) or the link your app shows (Settings → Devices → Show a code)" },
    json: { type: "boolean" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const sock = controlSocket(appData());
    const ask = async (cmd: string, a: Record<string, unknown> = {}, ms?: number) => {
      try {
        return await askHost(sock, cmd, a, ms);
      } catch (e) {
        if (e instanceof HostNotRunning) return err(ctx, "host_not_running", e.message, EXIT.unavailable);
        return err(ctx, "pair_failed", e instanceof Error ? e.message : String(e));
      }
    };
    // With --json, one line each: the code offered, then the device that entered it.
    const done = (paired: PairedDevice) => {
      const result = { paired: { device: paired.device, name: paired.name, kind: paired.kind } };
      if (ctx.json) console.log(JSON.stringify({ ok: true, data: result }));
      else console.log(`Paired with ${named(paired)}. It can open this host's workspaces now.`);
    };
    if (args.link) return done((await ask("pair-enter", { text: String(args.link) }, 60_000)) as PairedDevice);
    const offer = (await ask("pair-offer")) as { code: string; link: string; expires: number };
    if (ctx.json) console.log(JSON.stringify({ ok: true, data: { offer } }));
    else {
      process.stdout.write([
        "On your computer: Settings → Devices → Pair with a host, and enter",
        "",
        `  ${offer.code.split("-").join(" ")}`,
        "",
        "or the link (from another network, only the link finds this host):",
        "",
        `  ${offer.link}`,
        "",
        renderUnicodeCompact(offer.link, { border: 2 }),
        `The code works once, for five minutes. Waiting…`,
        "",
      ].join("\n"));
    }
    return done((await ask("pair-wait", {}, PAIR_WAIT_MS)) as PairedDevice);
  },
});

const stopCmd = defineCommand({
  meta: { name: "stop", description: "Stop serving; the terminals keep running in the daemon" },
  args: { json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const sock = controlSocket(appData());
    try {
      await askHost(sock, "stop");
    } catch (e) {
      if (e instanceof HostNotRunning) return ok(ctx, { stopped: false }, () => "hive host is not running here");
      return err(ctx, "host_unavailable", e instanceof Error ? e.message : String(e), EXIT.unavailable);
    }
    for (let t = 0; t < 10_000; t += 100) {
      try { await askHost(sock, "status", {}, 500); } catch (e) {
        if (e instanceof HostNotRunning) return ok(ctx, { stopped: true }, () => "stopped");
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return err(ctx, "host_stop_timeout", "hive host is still answering after 10s", EXIT.timeout);
  },
});

const addCmd = defineCommand({
  meta: { name: "add", description: "Serve a folder on this machine as one of its workspaces" },
  args: {
    path: { type: "positional", required: true, description: "the folder" },
    json: { type: "boolean" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const added = (await askHost(controlSocket(appData()), "add", { path: path.resolve(String(args.path)) })) as { repo: string; workspace: string };
      return ok(ctx, added, () => `serving ${added.repo} (workspace ${added.workspace.slice(0, 8)}…): your paired devices list it under Open recent`);
    } catch (e) {
      if (e instanceof HostNotRunning) return err(ctx, "host_not_running", e.message, EXIT.unavailable);
      return err(ctx, "add_failed", e instanceof Error ? e.message : String(e));
    }
  },
});

export const hostCmd = defineCommand({
  meta: { name: "host", description: "This machine as an always-on host of its workspaces, with no desktop" },
  subCommands: { run: runCmd, status: statusCmd, stop: stopCmd, pair: pairCmd, add: addCmd },
});
