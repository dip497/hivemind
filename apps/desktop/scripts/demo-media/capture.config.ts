import { defineConfig } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Same isolation as the e2e config: no network catalog, no Wayland, no agent's way into the person's app.
process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "hm-demo-xdg-"));
process.env.HIVEMIND_PLUGIN_INDEX = "file:///hivemind-demo-unreachable/index.json";
delete process.env.WAYLAND_DISPLAY;
process.env.XDG_SESSION_TYPE = "x11";
delete process.env.DBUS_SESSION_BUS_ADDRESS;
for (const name of ["HCP_TOKEN", "HIVE_HCP_SOCK", "HIVE_DRIVE_SOCK", "HIVEMIND_TILE", "HIVEMIND_APP_DATA", "ELECTRON_RUN_AS_NODE"]) delete process.env[name];
// Nor the session of an agent that runs the capture: its id, socket and mode would reach the real agents.
for (const name of Object.keys(process.env)) if (/^CLAUDE/.test(name)) delete process.env[name];

export default defineConfig({
  testDir: ".",
  testMatch: "capture.spec.ts",
  timeout: 1_800_000,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
});
