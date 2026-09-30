/**
 * `hive host` (R14; design §5.7): this machine as an always-on host, with no desktop. It serves the
 * workspaces in the app's data folder here to the devices their access lists let in, over
 * hive-net, and runs their terminals in this machine's PTY daemon, so agents keep working whoever
 * is connected, and after the host itself restarts.
 *
 *   hive host run       serve until stopped (what a service runs)
 *   hive host status    whether it runs, as which device, where it is reached, its workspaces
 *   hive host stop      stop serving; the terminals keep running in the daemon
 */
import { defineCommand } from "citty";
import net from "node:net";
import { applyShellEnvToProcess } from "@hivemind/agent-host/shell-env";
import { startHeadlessHost, type HeadlessHost } from "@hivemind/host/headless";
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
  };
}

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
    const control = await serveControl(controlSocket(dir), {
      status: () => { if (!host) throw new Error("hive host is starting"); return statusOf(host); },
      stop: () => { setTimeout(() => void shutdown(), 0); return { stopping: true }; },
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
      host = await startHeadlessHost({
        dir,
        daemon: async () => { await ensureDaemon(daemonSock); return connectTo(daemonSock); },
        hiveNet: hiveNetBin(),
        onWarn: (m) => process.stderr.write(`[host] ${m}\n`),
      });
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
    ].join("\n"));
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

export const hostCmd = defineCommand({
  meta: { name: "host", description: "This machine as an always-on host of its workspaces, with no desktop" },
  subCommands: { run: runCmd, status: statusCmd, stop: stopCmd },
});
