// Reap ONLY the pty-daemons this suite could have spawned — never the user's
// real one. The suite forces HIVEMIND_PTY_DAEMON=0 (see playwright.config), so
// normally no daemon is spawned at all; this is a defensive sweep in case a
// spec opts the daemon back on.
//
// CRITICAL: a blanket `pkill -f out/main/pty-daemon.js` ALSO kills the
// production daemon when hivemind is run from source (same script path) —
// that silently dropped the developer's live claude sessions. Every test
// daemon's socket lives under the OS temp dir (each spec uses a
// `--user-data-dir` under tmpdir, and that socket path is passed as the
// daemon's argv), while the real daemon's socket is under `$HOME/.config/`.
// Match the temp-dir socket path, which the production daemon can never have.
import { execSync } from "node:child_process";
import os from "node:os";

export default function globalTeardown(): void {
  const tmp = os.tmpdir(); // e.g. /tmp — the prefix of every test socket path
  try {
    // `-f` matches the full command line: `electron …/pty-daemon.js <socketPath>`.
    // Anchoring on the script + the tmp-dir socket prefix excludes the real
    // daemon (whose socket is under $HOME/.config).
    execSync(`pkill -f "out/main/pty-daemon.js ${tmp}/"`, { stdio: "ignore" });
  } catch {
    // pkill exits non-zero when nothing matches — fine.
  }
}
