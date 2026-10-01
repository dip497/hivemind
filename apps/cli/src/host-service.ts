/**
 * `hive host` as a service of this user (R14): a systemd user unit on Linux, started at boot (with
 * lingering on, before anyone logs in) and started again if it stops. Stopping or restarting it
 * stops only the host (`KillMode=process`): the PTY daemon it started, and the terminals and
 * agents in it, keep running through a restart or an upgrade.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configDir } from "./hcp.js";

export const UNIT = "hive-host.service";

/** Where this user's systemd units are. */
export const unitPath = (env: NodeJS.ProcessEnv = process.env): string => path.join(configDir(env), "systemd", "user", UNIT);

/** An argument as systemd reads it: quoted, with `\` and `"` escaped. */
const quoted = (arg: string): string => `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** The unit that runs `hive host run` with `argv` (this `hive`), and `env` set. */
export function unitFile(argv: string[], env: Record<string, string>): string {
  return [
    "[Unit]",
    "Description=hivemind host: this machine's workspaces, served to your devices",
    "Wants=network-online.target",
    "After=network-online.target",
    "",
    "[Service]",
    `ExecStart=${[...argv, "host", "run"].map(quoted).join(" ")}`,
    ...Object.entries(env).map(([k, v]) => `Environment=${quoted(`${k}=${v}`)}`),
    "Restart=on-failure",
    "RestartSec=5",
    "# Only the host: the PTY daemon it started, and the terminals and agents in it, keep running.",
    "KillMode=process",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** Run a command; its error text, or null when it worked. */
function run(cmd: string, args: string[]): string | null {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 30_000 });
  if (r.error) return r.error.message;
  return r.status === 0 ? null : (r.stderr || r.stdout || `exit ${r.status}`).trim();
}

export interface Installed {
  unit: string;
  /** Enabled and started by systemd now; when not, `todo` says how. */
  started: boolean;
  /** Started at boot before anyone logs in. */
  lingers: boolean;
  /** What is left for the person to run, and why. */
  todo: string[];
}

/** Write the unit and ask systemd to start it, now and at boot. */
export function install(argv: string[], env: Record<string, string>): Installed {
  const unit = unitPath();
  fs.mkdirSync(path.dirname(unit), { recursive: true });
  fs.writeFileSync(unit, unitFile(argv, env), { mode: 0o644 });
  const todo: string[] = [];
  const failed = run("systemctl", ["--user", "daemon-reload"]) ?? run("systemctl", ["--user", "enable", "--now", UNIT]);
  if (failed) todo.push(`systemctl --user daemon-reload && systemctl --user enable --now ${UNIT}   # systemd said: ${failed.split("\n")[0]}`);
  const user = os.userInfo().username;
  const lingered = run("loginctl", ["enable-linger", user]);
  if (lingered) todo.push(`sudo loginctl enable-linger ${user}   # to start it at boot, before anyone logs in`);
  return { unit, started: !failed, lingers: !lingered, todo };
}

/** Stop and disable the service, and remove its unit. False when there was none. */
export function uninstall(): boolean {
  const unit = unitPath();
  if (!fs.existsSync(unit)) return false;
  run("systemctl", ["--user", "disable", "--now", UNIT]);
  fs.rmSync(unit);
  run("systemctl", ["--user", "daemon-reload"]);
  return true;
}
