import { defineCommand } from "citty";
import { spawn } from "node:child_process";

// The official installer is also the upgrader: re-running it downloads the
// latest GitHub release if newer (or `git pull` + rebuild in --dev mode) and is
// a no-op when already current. `hive upgrade` just runs it.
const INSTALL_URL =
  "https://raw.githubusercontent.com/dip497/hivemind/main/install.sh";

export const upgradeCmd = defineCommand({
  meta: {
    name: "upgrade",
    description: "Upgrade hivemind to the latest release (re-runs the installer)",
  },
  args: {
    dev: {
      type: "boolean",
      description: "Upgrade a source (--dev) install: git pull + rebuild",
    },
  },
  async run({ args }) {
    const installArgs = args.dev ? "--dev" : "";
    // Pipe the installer into bash; `-s --` forwards our flags to it. stdio is
    // inherited so the installer's own progress/version output is shown live.
    // Replacing the running `hive` binary mid-run is safe on Linux (the path is
    // swapped to a new inode; this process keeps the old one until it exits).
    const cmd = `curl -fsSL ${INSTALL_URL} | bash -s -- ${installArgs}`.trim();
    const code: number = await new Promise((resolve) => {
      const child = spawn("bash", ["-c", cmd], { stdio: "inherit" });
      child.on("error", () => resolve(127));
      child.on("close", (c) => resolve(c ?? 0));
    });
    if (code !== 0) {
      process.stderr.write(`\nupgrade failed (exit ${code}). Is curl installed and online?\n`);
      process.exit(code);
    }
  },
});
