// Every terminal daemon the suite's apps started, stopped (each outlives its app): their sockets
// are in the temp dir, where the daemon of the app someone is using never has one.
import fs from "node:fs";
import os from "node:os";
import { stopDaemons } from "./helpers/daemons";

export default function globalTeardown(): void {
  const tmp = os.tmpdir();
  // First: a daemon still running writes into its profile.
  stopDaemons(tmp);
  // The isolated Electron profile playwright.config created for this run.
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.startsWith(tmp) && xdg.includes("hivemind-e2e-xdg-")) {
    try { fs.rmSync(xdg, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
