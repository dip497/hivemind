import { defineConfig } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Persistence is default-ON in the real app, but the detached pty-daemon
// intentionally outlives the window — and Playwright's electronApp.close()
// waits on child processes, so a persistent daemon stalls worker teardown ~60s.
// Tests run the in-process (legacy) PTY path via this opt-out; the daemon path
// is proven separately by the unit + real socket integration tests.
// electron.launch inherits this process's env, so setting it here propagates.
process.env.HIVEMIND_PTY_DAEMON = "0";

// Per run, not per spec: specs share settings.json, so isolate or restore what you persist.
process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "hivemind-e2e-xdg-"));

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  // No retries: the suite is a gate, and a flaky gate is not a gate. Every
  // spec must pass first time (they run under xvfb in CI-like conditions); a
  // test that needs a retry has a real ordering/timing bug to fix.
  retries: 0,
  reporter: [["list"]],
  // Reap detached pty-daemons spawned during the run (persistence is default-on).
  globalTeardown: "./tests/e2e/global-teardown.ts",
  use: {
    trace: "retain-on-failure",
  },
});
