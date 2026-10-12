// Every terminal daemon the suite's apps started, stopped (each outlives its app), and only those:
// another app's daemon may serve a socket in the temp dir too.
import fs from "node:fs";
import os from "node:os";
import { stopRunDaemons } from "./helpers/daemons";

export default function globalTeardown(): void {
  const run = process.env.HIVEMIND_E2E_XDG;
  // First: a daemon still running writes into its profile.
  if (run) stopRunDaemons(run);
  // The isolated Electron profile playwright.config created for this run.
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.startsWith(os.tmpdir()) && xdg.includes("hivemind-e2e-xdg-")) {
    try { fs.rmSync(xdg, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
