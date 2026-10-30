import { defineConfig } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seedAgents } from "./tests/e2e/helpers/agents";

// Per run, not per spec: specs share settings.json, so isolate or restore what you persist.
// Made once: each worker loads this file again, with the run's environment.
if (!process.env.HIVEMIND_E2E_XDG) {
  process.env.HIVEMIND_E2E_XDG = fs.mkdtempSync(path.join(os.tmpdir(), "hivemind-e2e-xdg-"));
  // Nothing is compiled in, so the shared profile installs the usual six from the published
  // fixtures — the same manifests a HiveHub auto-install would drop there.
  seedAgents(process.env.HIVEMIND_E2E_XDG);
}
process.env.XDG_CONFIG_HOME = process.env.HIVEMIND_E2E_XDG;
// No spec may touch the network: the catalog lives on HiveHub, and an unreachable index
// fails auto-install closed. Specs that build their own registry set their own value.
process.env.HIVEMIND_PLUGIN_INDEX = "file:///hivemind-e2e-unreachable/index.json";
// Windows go to the X display xvfb-run gives (DISPLAY): on a Wayland desktop Electron would
// otherwise open each one there, over the person's work, taking the keyboard.
delete process.env.WAYLAND_DISPLAY;
if (process.platform === "linux") process.env.XDG_SESSION_TYPE = "x11";
// Nor do its notifications reach the person's desktop, over their session bus.
delete process.env.DBUS_SESSION_BUS_ADDRESS;
// Run from an agent's terminal, the runner holds that agent's way into the person's own app: no
// spec, nor any app or `hive` it starts, may inherit it. A spec names its app's data folder. Nor the
// person's browser control: an app told it would take that app's debugging port, which is taken.
for (const name of ["HCP_TOKEN", "HIVE_HCP_SOCK", "HIVE_DRIVE_SOCK", "HIVEMIND_TILE", "HIVEMIND_APP_DATA", "HIVEMIND_BROWSER_CDP", "HIVEMIND_BROWSER_CDP_PORT", "HIVEMIND_BROWSER_TARGETS"]) delete process.env[name];

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
