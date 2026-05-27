import { defineConfig } from "@playwright/test";

// Persistence is default-ON in the real app, but the detached pty-daemon
// intentionally outlives the window — and Playwright's electronApp.close()
// waits on child processes, so a persistent daemon stalls worker teardown ~60s.
// Tests run the in-process (legacy) PTY path via this opt-out; the daemon path
// is proven separately by the unit + real socket integration tests.
// electron.launch inherits this process's env, so setting it here propagates.
process.env.HIVEMIND_PTY_DAEMON = "0";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  // One retry: the canvas drag/resize tests are timing-sensitive under load
  // (xvfb + heavy build). A genuine regression fails twice; a flake passes on
  // retry — so the suite stops red-flagging on the known resize flake.
  retries: 1,
  reporter: [["list"]],
  // Reap detached pty-daemons spawned during the run (persistence is default-on).
  globalTeardown: "./tests/e2e/global-teardown.ts",
  use: {
    trace: "retain-on-failure",
  },
});
