/** Is an agent's CLI on this machine, and which values do its options take (node only).
 *  Nothing runs until the binary is found; `--help` runs only once `--version` answers. */
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { choicesFromHelp, choicesFromList } from "./options.js";
import type { AgentOption, AgentProviderDef } from "./types.js";

export interface OptionChoices {
  values: string[];
  /** Where the values came from; null = the CLI did not say, so any value is typed. */
  from: "help" | "list" | null;
  error?: string;
}

export interface AgentPresence {
  /** Where the binary was found; null = not installed. */
  path: string | null;
  /** First line of `--version`, once it answered like a CLI. */
  version?: string;
  /** Found, but `--version` did not answer like a CLI: likely another program with the same name. */
  mismatch?: string;
}

const TIMEOUT_MS = 8000;
const VERSION_TIMEOUT_MS = 5000;
const probes = new Map<string, Promise<Record<string, OptionChoices>>>();
const versions = new Map<string, Promise<AgentPresence>>();
/** Finished checks, so a cheap presence answer can include what is already known. */
const settled = new Map<string, AgentPresence>();

export interface FindBinOpts {
  /** The environment the child will actually run with — a spread of Windows
   *  process.env carries `Path`, not `PATH`, so lookups must be case-insensitive. */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** File check, injectable so callers (and tests) can simulate a filesystem. */
  isFile?: (file: string) => boolean;
}

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/** Case-insensitive env read: on Windows, variable names keep whatever casing
 *  the first writer used (`Path` from a process.env spread, `PATH` from a
 *  hand-built object), and both must find the same variable. */
function envGet(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (name in env) return env[name];
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

export function findBin(bin: string, opts: FindBinOpts = {}): string | null {
  const { env = process.env, platform = process.platform } = opts;
  // Path semantics follow the TARGET platform, not the host — this must behave
  // identically when the win32 branch is simulated on another OS in tests.
  const p = platform === "win32" ? path.win32 : path;
  const isFile = opts.isFile ?? ((file: string): boolean => {
    try { return statSync(file).isFile(); } catch { return false; }
  });
  // "" = try the exact name; on POSIX that is the only candidate (no PATHEXT).
  const exts = platform === "win32"
    ? (envGet(env, "PATHEXT") ?? DEFAULT_PATHEXT).split(";").map((e) => e.trim()).filter(Boolean)
    : [""];
  // A PATHEXT of only separators falls back to the default rather than nothing.
  const pathExts = exts.length ? exts : DEFAULT_PATHEXT.split(";");
  // A name that already carries an extension is tried as-is first — Windows
  // matches `tool.exe` literally before falling back to PATHEXT appends.
  const hasExt = p.extname(bin) !== "";
  for (const dir of (envGet(env, "PATH") ?? "").split(p.delimiter)) {
    if (!dir) continue; // an empty entry would resolve against the working directory
    for (const ext of hasExt ? ["", ...pathExts] : pathExts) {
      const file = p.join(dir, bin + ext);
      if (isFile(file)) return file;
    }
  }
  return null;
}

/** A spawn spec node-pty accepts: argv, or on Windows a pre-escaped command
 *  line string (node-pty's `args: string[] | string` CommandLine form). */
export interface ResolvedSpawn { file: string; args: string[] | string; }

const CMD_SHIM = /\.(cmd|bat)$/i;

/**
 * Final (file, args) for a node-pty spawn of a session spec.
 *
 * Windows only; elsewhere — and for any cmd that names a path — the spec
 * passes through untouched. The spec's cmd itself must stay bare (session
 * matching keys on its basename), so this runs last, at the pty.spawn call
 * site. Without it a bare agent name can never start: node-pty's lookup
 * ignores PATHEXT, so the npm `.cmd` shim every agent CLI installs as is
 * invisible to it.
 *
 * A resolved `.cmd`/`.bat` shim is not executable by CreateProcess directly —
 * it is re-parented onto cmd.exe as one pre-escaped command line, using the
 * `/d /s /c` form so the inner quotes survive cmd's own parsing.
 */
export function resolveWindowsSpawn(
  cmd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  opts: FindBinOpts = {},
): ResolvedSpawn {
  const platform = opts.platform ?? process.platform;
  const p = platform === "win32" ? path.win32 : path;
  if (platform !== "win32" || /[\\/]/.test(cmd)) return { file: cmd, args: [...args] };
  const found = findBin(cmd, { ...opts, env, platform });
  // Unknown name: pass it through bare so node-pty's own ENOENT (and the
  // shell-env retry that recovers a half-loaded PATH) still applies.
  if (!found || !CMD_SHIM.test(found)) return { file: found ?? cmd, args: [...args] };
  for (const a of args) {
    if (a.includes("\r") || a.includes("\n")) {
      throw new Error(`cannot run ${p.basename(found)}: a cmd.exe command line cannot carry CR/LF`);
    }
  }
  const line = [`"${found}"`, ...args.map(quoteWindowsArg)].join(" ");
  // A string, not an array: node-pty passes a string through as the raw command line.
  return { file: envGet(env, "ComSpec") || "cmd.exe", args: `/d /s /c "${line}"` };
}

/** Quote one argument per the CommandLineToArgvW rules node-pty's string form
 *  expects: quote anything with whitespace/quotes, backslash-escape embedded
 *  quotes (doubling the backslashes that immediately precede them). */
function quoteWindowsArg(arg: string): string {
  if (arg !== "" && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let slashes = 0;
  for (const ch of arg) {
    if (ch === "\\") { slashes++; continue; }
    if (ch === '"') out += "\\".repeat(slashes * 2 + 1) + '"';
    else out += "\\".repeat(slashes) + ch;
    slashes = 0;
  }
  return `${out}${"\\".repeat(slashes)}"`;
}

/** No display and no browser: a same-named desktop app must not open windows or pages. */
function probeEnv(): NodeJS.ProcessEnv {
  const { DISPLAY: _d, WAYLAND_DISPLAY: _w, ...env } = process.env;
  return { ...env, NO_COLOR: "1", TERM: "dumb", BROWSER: "false" };
}

const WIN = process.platform === "win32";

/** Kill the probe and anything it started. */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (WIN) { try { spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch { /* gone */ } return; }
  try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
}

function run(file: string, args: string[], opts: { stderr: boolean; timeoutMs?: number }): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    // npm's .cmd shims need a shell on Windows; args here are fixed tokens, never user text.
    const shim = WIN && /\.(cmd|bat)$/i.test(file);
    // Own process group, so a timeout takes down anything it started too.
    const child = spawn(shim ? `"${file}"` : file, args, { env: probeEnv(), detached: !WIN, shell: shim, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", size = 0;
    const take = (b: Buffer, to: "out" | "err") => {
      size += b.length;
      if (size > 4 << 20) return;
      if (to === "out") stdout += b; else stderr += b;
    };
    child.stdout.on("data", (b: Buffer) => take(b, "out"));
    child.stderr.on("data", (b: Buffer) => take(b, "err"));
    const timer = setTimeout(() => {
      killTree(child.pid);
      reject(new Error(`${path.basename(file)} ${args.join(" ")} did not finish in ${(opts.timeoutMs ?? TIMEOUT_MS) / 1000}s`));
    }, opts.timeoutMs ?? TIMEOUT_MS);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!WIN) killTree(child.pid); // anything it left running in the background
      resolve({ code, out: opts.stderr ? `${stdout}\n${stderr}` : stdout });
    });
  });
}

const keyOf = (file: string): string => `${file}\0${statSync(file).mtimeMs}`;

/** Found on PATH, plus any `--version` verdict already reached. Runs nothing. */
export function agentPresence(def: AgentProviderDef): AgentPresence {
  const file = findBin(def.bin);
  if (!file) return { path: null };
  let known: AgentPresence | undefined;
  try { known = settled.get(keyOf(file)); } catch { /* vanished */ }
  return known ?? { path: file };
}

/** Found, and answering `--version` the way a CLI does: exit 0, a version on its first line. */
export function verifyAgent(def: AgentProviderDef): Promise<AgentPresence> {
  const file = findBin(def.bin);
  if (!file) return Promise.resolve({ path: null });
  const key = keyOf(file);
  let hit = versions.get(key);
  if (!hit) {
    hit = run(file, ["--version"], { stderr: true, timeoutMs: VERSION_TIMEOUT_MS }).then(({ code, out }) => {
      const first = out.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
      const verdict: AgentPresence = code === 0 && /\d+\.\d+/.test(first) && first.length < 120
        ? { path: file, version: first }
        : { path: file, mismatch: `${def.bin} --version did not print a version` };
      settled.set(key, verdict);
      return verdict;
    }, (e: Error) => {
      versions.delete(key); // a slow cold start is not a verdict; ask again next time
      return { path: file, mismatch: e.message };
    });
    versions.set(key, hit);
  }
  return hit;
}

async function probe(file: string, options: readonly AgentOption[]): Promise<Record<string, OptionChoices>> {
  const help = run(file, ["--help"], { stderr: true }).then((r) => r.out, () => "");
  const entries = await Promise.all(options.map(async (o): Promise<[string, OptionChoices]> => {
    let error: string | undefined;
    if (o.list) {
      try {
        const { code, out } = await run(file, o.list.args, { stderr: false });
        const values = code === 0 ? choicesFromList(out, o.list) : [];
        if (values.length) return [o.id, { values, from: "list" }];
        if (code !== 0) error = `${path.basename(file)} ${o.list.args.join(" ")} failed`;
      } catch (e) { error = (e as Error).message; }
    }
    const values = o.flag ? choicesFromHelp(await help, o.flag) : [];
    return [o.id, { values, from: values.length ? "help" : null, ...(error ? { error } : {}) }];
  }));
  return Object.fromEntries(entries);
}

export async function discoverOptions(def: AgentProviderDef): Promise<Record<string, OptionChoices>> {
  const options = def.options ?? [];
  if (!options.length) return {};
  const presence = await verifyAgent(def);
  if (!presence.path || !presence.version) {
    const why: OptionChoices = { values: [], from: null, error: presence.mismatch ?? `${def.bin} is not installed` };
    return Object.fromEntries(options.map((o) => [o.id, why]));
  }
  const key = `${def.id}\0${keyOf(presence.path)}`;
  let hit = probes.get(key);
  if (!hit) {
    hit = probe(presence.path, options);
    probes.set(key, hit);
  }
  return hit;
}
