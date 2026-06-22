/**
 * Linux-only user-shell environment resolver. Hand-rolled equivalent of
 * sindresorhus/shell-env + superset.sh's `execWithShellEnv`, with TTL
 * caching, concurrent-dogpile latch, ANSI stripping, oh-my-zsh-friendly
 * spawn env, and POSIX-shell fallbacks. No runtime npm dep.
 *
 * Goal: spawn the user's login shell ONCE at app startup, capture its full
 * environment, and patch `process.env` so every later pty/git/exec call
 * sees the user's tools (`claude`, `gh`, nvm-managed node, asdf shims,
 * Bun) AND tokens (`ANTHROPIC_API_KEY`, `GH_TOKEN`, `OPENAI_API_KEY`, …).
 *
 * Existing `process.env` values always win — Electron-managed vars are not
 * clobbered. PATH is the deliberate exception (always replaced with the
 * resolved-and-merged value).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// Three-tier TTL cache (superset pattern).
const SUCCESS_TTL_MS = 60_000;
const FALLBACK_TTL_MS = 10_000;
const TIMEOUT_TTL_MS = 60_000;
const SHELL_TIMEOUT_MS = 8_000;

interface CachedResult {
  env: Record<string, string>;
  expires: number;
  source: "shell" | "fallback" | "timeout-fallback";
}

let cache: CachedResult | null = null;
let inFlight: Promise<CachedResult> | null = null;

// One-shot latch so concurrent ENOENT recoveries don't dogpile.
let processPatched = false;

/** Resolve once + patch process.env. Idempotent. Safe to await at startup
 *  AND inside an ENOENT retry — second call is a no-op when patched.
 *  Returns the env map for tests; production callers can ignore the return. */
export async function applyShellEnvToProcess(): Promise<Record<string, string>> {
  const result = await resolveShellEnv();
  if (!processPatched) {
    processPatched = true;
    mergeIntoProcessEnv(result.env);
  }
  return result.env;
}

async function resolveShellEnv(): Promise<CachedResult> {
  const now = Date.now();
  if (cache && cache.expires > now) return cache;
  if (inFlight) return inFlight;
  inFlight = doResolve().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Env vars passed TO the spawned shell. Per sindresorhus/shell-env:
 *  prevents oh-my-zsh auto-update + tmux-plugin auto-start, which can hang
 *  the shell long enough to trip our 8s timeout. */
const SPAWN_ENV: Record<string, string> = {
  DISABLE_AUTO_UPDATE: "true",
  ZSH_TMUX_AUTOSTARTED: "true",
  ZSH_TMUX_AUTOSTART: "false",
};

/** Fallback POSIX shells to try if the user's $SHELL fails (Nushell, fish,
 *  etc. don't support `-ilc`). Exclude the already-tried default. */
function fallbackShells(defaultShell: string): string[] {
  return ["/bin/zsh", "/bin/bash"].filter((s) => s !== defaultShell);
}

/** Strip ANSI CSI / OSC sequences so colorized prompts in rc files don't
 *  corrupt parsing. Same regex shape as `strip-ansi`. */
const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /[][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

async function tryShell(shell: string): Promise<Record<string, string> | null> {
  const { stdout } = await raceWithTimeout(
    execFileP(
      shell,
      // `command` prefix bypasses user-defined `env` aliases/functions.
      // `-0` (NUL-separated) tolerates values with newlines/equals.
      [
        "-ilc",
        "printf '__HIVE_ENV_BEGIN__'; command env -0; printf '__HIVE_ENV_END__'",
      ],
      {
        encoding: "buffer",
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, ...SPAWN_ENV },
      },
    ),
    SHELL_TIMEOUT_MS,
  );
  const text = (stdout as Buffer).toString("utf8").replace(ANSI_RE, "");
  const m = text.match(/__HIVE_ENV_BEGIN__([\s\S]*?)__HIVE_ENV_END__/);
  if (!m || !m[1]) return null;
  const env = parseNulEnv(m[1]);
  return Object.keys(env).length > 0 ? env : null;
}

async function doResolve(): Promise<CachedResult> {
  const now = Date.now();
  const defaultShell = process.env.SHELL || "/bin/bash";
  const shells = [defaultShell, ...fallbackShells(defaultShell)];

  let timedOut = false;
  for (const shell of shells) {
    try {
      const env = await tryShell(shell);
      if (env) {
        const result: CachedResult = {
          env,
          expires: now + SUCCESS_TTL_MS,
          source: "shell",
        };
        cache = result;
        return result;
      }
    } catch (e) {
      if ((e as Error).message === "shell-env-timeout") timedOut = true;
      // try next fallback shell
    }
  }

  const result: CachedResult = {
    env: { ...process.env } as Record<string, string>,
    expires: now + (timedOut ? TIMEOUT_TTL_MS : FALLBACK_TTL_MS),
    source: timedOut ? "timeout-fallback" : "fallback",
  };
  cache = result;
  return result;
}

function raceWithTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error("shell-env-timeout")), ms),
    ),
  ]);
}

/** Parse `env -0` output: NUL-separated KEY=VALUE entries. */
function parseNulEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of text.split("\0")) {
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const key = entry.slice(0, eq);
    const value = entry.slice(eq + 1);
    out[key] = value;
  }
  return out;
}

/** Merge shell env into process.env. Existing process.env values WIN
 *  (so Electron-managed vars like ELECTRON_RUN_AS_NODE aren't clobbered). */
function mergeIntoProcessEnv(env: Record<string, string>): void {
  for (const [k, v] of Object.entries(env)) {
    if (!(k in process.env)) {
      process.env[k] = v;
    }
  }
  // PATH is special: ALWAYS overwrite with the resolved one (it's a merger
  // of system + shell + rescue, so it strictly dominates current PATH).
  if (env.PATH) process.env.PATH = env.PATH;
}

/**
 * Strip Electron-internal runtime vars from the env handed to a USER-FACING
 * terminal shell (a tile PTY). The persistence daemon runs as electron-as-node
 * (spawned with ELECTRON_RUN_AS_NODE=1 — daemon-client.ts), and its PTY factory
 * inherits `process.env`, so without this every terminal tile carries
 * ELECTRON_RUN_AS_NODE=1. Then ANY Electron app launched from a hivemind terminal
 * — hivemind itself, VS Code, Slack — runs in node-mode and crashes importing its
 * GUI: `TypeError: Cannot read properties of undefined (reading 'exports')` at
 * cjsPreparseModuleExports. (That is exactly why "open a terminal in hivemind,
 * run hivemind" died.) A user shell must look like a normal login shell, not
 * electron-as-node. Mutates + returns the env for chaining.
 */
const ELECTRON_INTERNAL_ENV = ["ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE"] as const;

export function sanitizeShellEnv(env: Record<string, string>): Record<string, string> {
  for (const k of ELECTRON_INTERNAL_ENV) delete env[k];
  return env;
}
