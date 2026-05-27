// Persistence is default-on: terminal sessions live in a detached pty-daemon
// that intentionally survives the window. After the e2e suite we reap any
// daemons (and their child shells) so test runs don't leak processes. Each test
// uses a unique --user-data-dir → its own socket → its own daemon, so a blanket
// pkill is safe here.
import { execSync } from "node:child_process";

export default function globalTeardown(): void {
  try {
    execSync("pkill -f out/main/pty-daemon.js", { stdio: "ignore" });
  } catch {
    // pkill exits non-zero when nothing matches — fine.
  }
}
