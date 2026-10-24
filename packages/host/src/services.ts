/**
 * Tool plugins' services (docs/design/drive-api-2026-10-09.md, D8): the program a plugin keeps
 * running while it is on, driving the workspaces picked for it through the drive socket, as a
 * grant made when it starts and taken back when it stops. A failing exit is started again after
 * 1 s, doubling to 60 s; a clean exit, or its grant taken back, stops it. What it prints is kept
 * in `<logDir>/<owner>--<name>.log`. Electron-free.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { findBin } from "@hivemind/agents/discover";
import { isPluginOn, serviceWorkspaces, type PluginState } from "@hivemind/core/plugin-settings";
import { toolFolder, type ToolPackage, type ToolService } from "@hivemind/core/tool-format";
import { ROLES, type Role } from "@hivemind/workspace-host/access";
import type { Grants } from "./grants.js";

/** A service that should run: its plugin is on. */
export interface WantedService {
  plugin: string;
  /** The plugin's name, which its grant is called by. */
  name: string;
  /** The plugin's folder, where the service runs. */
  dir: string;
  service: ToolService;
  /** The workspaces picked for it, by their folder. */
  workspaces: string[];
}

/** The services that should run: those of the tool plugins switched on that load here. In safe
 *  mode, none. */
export function wantedServices(packages: ToolPackage[], states: Record<string, PluginState>, safeMode: boolean): WantedService[] {
  if (safeMode) return [];
  return packages
    .filter((p) => p.service && !p.problem && isPluginOn(states, "tool", p, p.source === "app"))
    .map((p) => ({ plugin: p.id, name: p.name, dir: p.dir, service: p.service!, workspaces: serviceWorkspaces(states, p.id) }));
}

export interface ServiceState {
  plugin: string;
  /** running; waiting to start again; stopped, and not started again until something changes. */
  state: "running" | "restarting" | "stopped";
  /** Why it is not running. */
  why?: string;
  /** When it got to this state, ms since the epoch. */
  since: number;
  /** When it starts again, while restarting. */
  restartAt?: number;
}

export interface ServicesOptions {
  /** The drive socket the services are told of. */
  driveSock: string;
  grants: Grants;
  /** Where their logs are kept. */
  logDir: string;
  /** Something about a service changed. */
  onChange?(): void;
  /** The host's own JavaScript runtime, for a service whose command is `node` on a machine with
   *  none on PATH: the app's Electron, run as Node (`ELECTRON_RUN_AS_NODE=1`). None under `hive
   *  host`, which then says how to get one. */
  node?: { file: string; env: Record<string, string> };
}

const WIN = process.platform === "win32";
const FIRST_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;
/** A run this long starts the count of failures again. */
const HEALTHY_MS = 60_000;
const TERM_WAIT_MS = 3_000;
const LOG_MAX = 1024 * 1024;

/** What of the app's environment a service gets: where programs are, who and where the person is.
 *  Never the rest: an app started from an agent's tile carries that agent's token. */
const KEPT_ENV = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR",
  "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
  "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "ComSpec", "PATHEXT",
];

export function serviceEnv(from: NodeJS.ProcessEnv, own: Record<string, string>): NodeJS.ProcessEnv {
  const kept = new Set(KEPT_ENV.map((k) => k.toLowerCase()));
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(from)) if (v !== undefined && kept.has(k.toLowerCase())) env[k] = v;
  return { ...env, ...own };
}

/** What to start for `want`, or why it cannot start; `env`: what it adds to the environment. */
function program(want: WantedService, env: NodeJS.ProcessEnv, node: ServicesOptions["node"]): { file: string; args: string[]; env?: Record<string, string> } | { why: string } {
  const [bin, ...args] = want.service.command as [string, ...string[]];
  if (bin.startsWith("./")) {
    const file = path.join(want.dir, bin.slice(2));
    try {
      if (fs.statSync(file).isFile()) return { file, args };
    } catch { /* below */ }
    return { why: `${bin} is not in the plugin's folder` };
  }
  const file = findBin(bin, { env });
  // A .cmd/.bat shim starts only through cmd.exe, which parses its arguments again.
  const shim = !!file && /\.(cmd|bat)$/i.test(file);
  // Node a service needs comes with the app: a machine that installed the app alone has none.
  if (bin === "node" && (!file || shim) && node) return { file: node.file, args, env: node.env };
  if (!file) return { why: bin === "node" ? "node is not installed on this machine: install Node.js (https://nodejs.org), or run the service in the app, which brings its own" : `${bin} is not installed on this machine` };
  if (shim) return { why: `${bin} is a script shim here, which a service cannot run without a shell` };
  return { file, args };
}

/** The log file a plugin's service writes, rolled over at 1 MB to one older file. */
class Log {
  private size: number;
  constructor(readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  }
  // Called from the service's output: a log that cannot be written loses lines, never the app.
  write(text: string | Buffer): void {
    try {
      if (this.size >= LOG_MAX) {
        fs.renameSync(this.file, `${this.file}.1`);
        this.size = 0;
      }
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, text);
      this.size += Buffer.byteLength(text);
    } catch { /* disk full, or the folder gone and not made again */ }
  }
  say(line: string): void {
    this.write(`— ${new Date().toISOString()} ${line}\n`);
  }
}

/** One plugin's service: started, kept going, stopped. */
class Runner {
  state: ServiceState;
  private child: ChildProcess | null = null;
  private grant: string | null = null;
  private delay = FIRST_DELAY_MS;
  private again: ReturnType<typeof setTimeout> | null = null;
  private ending = false;
  private exited: Promise<void> = Promise.resolve();

  constructor(readonly want: WantedService, private readonly o: ServicesOptions, private readonly log: Log) {
    this.state = { plugin: want.plugin, state: "stopped", since: Date.now() };
  }

  start(): void {
    this.again = null;
    if (this.ending) return;
    const { want, o } = this;
    if (want.workspaces.length === 0) return this.set({ state: "stopped", why: "no workspace is picked for it" });
    if (!(ROLES as readonly string[]).includes(want.service.role)) return this.set({ state: "stopped", why: `it asks for the role "${want.service.role}", which is none of ${ROLES.join(", ")}` });
    const found = program(want, process.env, o.node);
    if ("why" in found) return this.set({ state: "stopped", why: found.why });
    // Named for its plugin: what it writes (an issue's activity) is signed so.
    const { grant, token } = o.grants.create({ name: `${want.plugin} (service)`, repos: want.workspaces, role: want.service.role as Role }, want.plugin);
    this.grant = grant.id;
    const env = serviceEnv(process.env, { ...found.env, HIVE_DRIVE_SOCK: o.driveSock, HIVE_DRIVE_TOKEN: token, HIVE_WORKSPACES: grant.repos.join(path.delimiter) });
    let child: ChildProcess;
    try {
      // Its own process group, so stopping it stops what it started. Its stdin is a pipe that
      // closes when the app goes, however it goes.
      child = spawn(found.file, found.args, { cwd: want.dir, env, stdio: ["pipe", "pipe", "pipe"], detached: !WIN, windowsHide: true });
    } catch (e) {
      return this.ended(`it did not start: ${(e as Error).message}`, Date.now());
    }
    this.child = child;
    const started = Date.now();
    child.stdout!.on("data", (d: Buffer) => this.log.write(d));
    child.stderr!.on("data", (d: Buffer) => this.log.write(d));
    child.stdin!.on("error", () => { /* it closed its stdin */ });
    let done!: () => void;
    this.exited = new Promise((r) => (done = r));
    let over = false;
    const end = (why: string, clean: boolean) => {
      if (over) return;
      over = true;
      this.child = null;
      done();
      this.ended(why, started, clean);
    };
    child.once("error", (e) => end(`it did not start: ${e.message}`, false));
    child.once("exit", (code, signal) => end(code === 0 ? "it exited" : `it exited (${signal ?? code})`, code === 0));
    if (child.pid !== undefined) {
      this.log.say(`started, pid ${child.pid}`);
      this.set({ state: "running" });
    }
  }

  /** Its grant was taken back elsewhere: it stops, and stays stopped. */
  revoked(id: string): void {
    if (id !== this.grant) return;
    this.grant = null;
    this.halt("its grant was taken back");
  }

  /** Stop it, its grant taken back, and keep it stopped. */
  async stop(why = "its plugin was switched off"): Promise<void> {
    this.halt(why);
    await this.exited;
  }

  private halt(why: string): void {
    this.ending = true;
    if (this.again) clearTimeout(this.again);
    this.again = null;
    this.takeBack();
    const child = this.child;
    if (child) {
      this.log.say(`stopping: ${why}`);
      kill(child, "SIGTERM");
      const hard = setTimeout(() => kill(child, "SIGKILL"), TERM_WAIT_MS);
      hard.unref();
      void this.exited.then(() => clearTimeout(hard));
    }
    this.set({ state: "stopped", why });
  }

  private ended(why: string, started: number, clean = false): void {
    this.takeBack();
    if (this.ending) return;
    this.log.say(why);
    if (clean) return this.set({ state: "stopped", why });
    this.delay = Date.now() - started >= HEALTHY_MS ? FIRST_DELAY_MS : this.delay;
    const wait = this.delay;
    this.delay = Math.min(this.delay * 2, MAX_DELAY_MS);
    this.again = setTimeout(() => this.start(), wait);
    this.set({ state: "restarting", why, restartAt: Date.now() + wait });
  }

  private takeBack(): void {
    const id = this.grant;
    this.grant = null;
    if (id) this.o.grants.revoke(id);
  }

  private set(s: Omit<ServiceState, "plugin" | "since">): void {
    this.state = { plugin: this.want.plugin, ...s, since: Date.now() };
    this.o.onChange?.();
  }
}

function kill(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (WIN) {
    try { spawn("taskkill", ["/pid", String(child.pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])], { windowsHide: true, stdio: "ignore" }); } catch { /* gone */ }
    return;
  }
  try { process.kill(-child.pid, signal); } catch { /* gone */ }
}

const sameWant = (a: WantedService, b: WantedService): boolean =>
  a.dir === b.dir && a.name === b.name && a.service.role === b.service.role
  && JSON.stringify(a.service.command) === JSON.stringify(b.service.command)
  && JSON.stringify([...a.workspaces].sort()) === JSON.stringify([...b.workspaces].sort());

export class Services {
  private readonly runners = new Map<string, Runner>();
  private readonly offRevoked: () => void;

  /** Made by the process that serves the drive socket, once it does. */
  constructor(private readonly o: ServicesOptions) {
    o.grants.revokeServices();
    this.offRevoked = o.grants.onRevoked((id) => { for (const r of this.runners.values()) r.revoked(id); });
  }

  /** Run exactly the services in `wanted`: one no longer wanted is stopped, one changed is started
   *  again with a new grant. */
  async sync(wanted: WantedService[]): Promise<void> {
    const next = new Map(wanted.map((w) => [w.plugin, w]));
    const stopping: Promise<void>[] = [];
    for (const [plugin, r] of this.runners) {
      const w = next.get(plugin);
      if (w && sameWant(w, r.want)) continue;
      this.runners.delete(plugin);
      stopping.push(r.stop(w ? "it changed" : "its plugin was switched off"));
    }
    await Promise.all(stopping);
    for (const w of next.values()) {
      if (this.runners.has(w.plugin)) continue;
      const r = new Runner(w, this.o, new Log(this.logFile(w.plugin)));
      this.runners.set(w.plugin, r);
      r.start();
    }
    if (stopping.length) this.o.onChange?.();
  }

  /** How each service is. */
  states(): ServiceState[] {
    return [...this.runners.values()].map((r) => r.state);
  }

  /** The end of what `plugin`'s service printed, at most `bytes` of it. */
  log(plugin: string, bytes = 16 * 1024): string {
    const file = this.logFile(plugin);
    let fd: number;
    try {
      fd = fs.openSync(file, "r");
    } catch {
      return "";
    }
    try {
      const size = fs.fstatSync(fd).size;
      const n = Math.min(size, bytes);
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, size - n);
      return buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Stop them all, as the app or host stops. */
  async stop(): Promise<void> {
    this.offRevoked();
    const all = [...this.runners.values()];
    this.runners.clear();
    await Promise.all(all.map((r) => r.stop("the app stopped")));
  }

  private logFile(plugin: string): string {
    return path.join(this.o.logDir, `${toolFolder(plugin)}.log`);
  }
}
