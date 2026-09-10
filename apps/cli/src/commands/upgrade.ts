import { defineCommand } from "citty";
import { spawn } from "node:child_process";

// The official installer is also the upgrader: re-running it downloads the
// latest GitHub release if newer (or `git pull` + rebuild in --dev mode) and is
// a no-op when already current. `hive upgrade` just runs it.
const INSTALL_URL =
  "https://raw.githubusercontent.com/dip497/hivemind/main/install.sh";
const INSTALL_PS1_URL =
  "https://raw.githubusercontent.com/dip497/hivemind/main/install.ps1";

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
    // Windows has no bash and a different installer; everywhere else, pipe
    // install.sh into bash. Replacing the running binary mid-run is safe on
    // POSIX (the path gets a new inode, this process keeps the old one) and on
    // Windows install.ps1 stages the .exe rather than overwriting it in place.
    const win = process.platform === "win32";
    // `irm | iex` cannot forward arguments, so the Windows path builds a
    // scriptblock from the downloaded text and invokes it — the documented way
    // to pass parameters to a remote PowerShell script.
    const psInvoke = args.dev
      ? `& ([scriptblock]::Create((irm ${INSTALL_PS1_URL}))) -Dev`
      : `irm ${INSTALL_PS1_URL} | iex`;
    const [file, argv] = win
      ? ["powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psInvoke]]
      : ["bash", ["-c", `curl -fsSL ${INSTALL_URL} | bash -s -- ${installArgs}`.trim()]];
    const code: number = await new Promise((resolve) => {
      const child = spawn(file, argv, { stdio: "inherit" });
      child.on("error", () => resolve(127));
      child.on("close", (c) => resolve(c ?? 0));
    });
    if (code !== 0) {
      const hint = process.platform === "win32" ? "Are you online?" : "Is curl installed and online?";
      process.stderr.write(`\nupgrade failed (exit ${code}). ${hint}\n`);
      process.exit(code);
    }
  },
});
