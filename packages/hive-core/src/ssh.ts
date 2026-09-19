/** ssh helpers shared by the CLI and the desktop: quoting and the remote probe. */
import { HiveError } from "./storage.js";

/** The remote shell sees exactly one word. */
export const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export interface ProbeResult {
  platform: string;
  hivePath?: string;
  hiveVersion?: string;
  /** Its `hive` can run the terminal daemon the desktop bridges to (older ones cannot). */
  daemon?: boolean;
}

/** Matches the release asset names (`hive-linux-x86_64`, `hive-darwin-arm64`). */
export function platformOf(os: string, arch: string): string | null {
  const o = os.trim() === "Linux" ? "linux" : os.trim() === "Darwin" ? "darwin" : null;
  const a = /^(x86_64|amd64)$/.test(arch.trim()) ? "x86_64" : /^(aarch64|arm64)$/.test(arch.trim()) ? "arm64" : null;
  return o && a ? `${o}-${a}` : null;
}

export function localPlatform(): string | null {
  return platformOf(process.platform === "linux" ? "Linux" : process.platform === "darwin" ? "Darwin" : "", process.arch === "x64" ? "x86_64" : process.arch);
}

/** Runs `script` with `sh` whatever the remote login shell is (fish, zsh…); `args` arrive as $1… */
export function shScript(script: string, ...args: string[]): string {
  return `sh -c ${shq(script)} hive${args.map((a) => ` ${shq(a)}`).join("")}`;
}

// Tagged lines, so a noisy remote shell profile cannot confuse the parser.
export const PROBE = shScript([
  `printf 'HIVEPROBE-UNAME %s %s\\n' "$(uname -s)" "$(uname -m)"`,
  `for p in "$HOME/.local/bin/hive" /usr/local/bin/hive /opt/homebrew/bin/hive "$(command -v hive 2>/dev/null)"; do`,
  `  if [ -n "$p" ] && [ -x "$p" ]; then printf 'HIVEPROBE-PATH %s\\n' "$p"; printf 'HIVEPROBE-VERSION %s\\n' "$("$p" --version 2>/dev/null | head -n1)";`,
  `    if "$p" daemon --help 2>&1 | grep -q bridge; then printf 'HIVEPROBE-DAEMON yes\\n'; fi; break; fi`,
  `done`,
].join("\n"));

export function parseProbe(out: string): ProbeResult {
  const line = (tag: string) => out.split("\n").find((l) => l.startsWith(`HIVEPROBE-${tag} `))?.slice(`HIVEPROBE-${tag} `.length).trim();
  const uname = line("UNAME");
  if (!uname) throw new HiveError("machine_probe_failed", "remote did not answer the probe (is it a POSIX shell?)");
  const [os = "", arch = ""] = uname.split(" ");
  const platform = platformOf(os, arch);
  if (!platform) throw new HiveError("machine_unsupported", `unsupported remote platform '${uname}' — Linux or macOS on x86_64/arm64 only`);
  const hivePath = line("PATH");
  const res: ProbeResult = { platform };
  if (hivePath) {
    if (!hivePath.startsWith("/")) throw new HiveError("machine_probe_failed", `remote reported a relative hive path '${hivePath}'`);
    res.hivePath = hivePath;
    const v = line("VERSION");
    if (v) res.hiveVersion = v;
    if (line("DAEMON") === "yes") res.daemon = true;
  }
  return res;
}

/** Platforms with a `hive-<platform>` release asset. */
export const PUBLISHED_PLATFORMS = ["linux-x86_64", "linux-arm64", "darwin-arm64"];

export function releaseAssetUrl(platform: string, version: string, repo = "dip497/hivemind"): string {
  return `https://github.com/${repo}/releases/download/v${version}/hive-${platform}`;
}

// Temp file + rename, so a dropped connection or failed download can't leave a truncated `hive`.
const INSTALL_HEAD = `set -e; mkdir -p "$HOME/.local/bin"; tmp="$HOME/.local/bin/.hive.$$.tmp"; trap 'rm -f "$tmp"' EXIT`;
const INSTALL_TAIL = `chmod 755 "$tmp"; mv -f "$tmp" "$HOME/.local/bin/hive"; printf '%s\\n' "$HOME/.local/bin/hive"`;

/** Installs stdin as `~/.local/bin/hive`, only if exactly `bytes` arrived (a cut connection ends `cat` cleanly). */
export function installCopyCommand(bytes: number): string {
  return shScript(`${INSTALL_HEAD}; cat > "$tmp"; n=$(wc -c < "$tmp"); [ $n -eq "$1" ] || { echo "received $n of $1 bytes" >&2; exit 1; }; ${INSTALL_TAIL}`, String(bytes));
}

/** Downloads `url` on the remote as `~/.local/bin/hive`. */
export function installFetchCommand(url: string): string {
  return shScript(`${INSTALL_HEAD}; if command -v curl >/dev/null 2>&1; then curl -fsSL -o "$tmp" "$1"; elif command -v wget >/dev/null 2>&1; then wget -qO "$tmp" "$1"; else echo "neither curl nor wget is installed" >&2; exit 1; fi; ${INSTALL_TAIL}`, url);
}
