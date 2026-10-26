/** ssh helpers shared by the CLI and the desktop: quoting and the remote probe. */
import { HiveError } from "./storage.js";

/** The remote shell sees exactly one word. */
export const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** What kind of computer a machine is, as the machine itself reports it. */
export const MACHINE_KINDS = ["laptop", "desktop", "server", "virtual-machine", "container"] as const;
export type MachineKind = (typeof MACHINE_KINDS)[number];
export const isMachineKind = (v: unknown): v is MachineKind => (MACHINE_KINDS as readonly unknown[]).includes(v);

/** Prints `HIVEPROBE-KIND <kind>`, empty when the machine does not say: a Mac with a battery is a
 *  laptop; on Linux a container or a virtual machine first, then the chassis its firmware reports. */
export const KIND_SCRIPT = [
  `k=`,
  `if [ "$(uname -s)" = Darwin ]; then if pmset -g batt 2>/dev/null | grep -q InternalBattery; then k=laptop; else k=desktop; fi`,
  `else`,
  `  if [ -f /.dockerenv ] || [ -f /run/.containerenv ]; then k=container; else`,
  `    case "$(systemd-detect-virt 2>/dev/null)" in ""|none) ;; docker|podman|lxc|lxc-libvirt|systemd-nspawn|openvz|rkt|wsl|proot|pouch|container-other) k=container ;; *) k=virtual-machine ;; esac`,
  `  fi`,
  `  if [ -z "$k" ]; then case "$(cat /sys/class/dmi/id/chassis_type 2>/dev/null)" in`,
  `    8|9|10|14|30|31|32) k=laptop ;; 3|4|5|6|7|13|15|16|24|35|36) k=desktop ;; 17|23|25|28|29) k=server ;; esac; fi`,
  `fi`,
  `printf 'HIVEPROBE-KIND %s\\n' "$k"`,
].join("\n");

/** The kind in a probe's output, if it named one. */
export function kindIn(out: string): MachineKind | undefined {
  const k = out.split("\n").find((l) => l.startsWith("HIVEPROBE-KIND "))?.slice("HIVEPROBE-KIND ".length).trim();
  return isMachineKind(k) ? k : undefined;
}

export interface ProbeResult {
  platform: string;
  kind?: MachineKind;
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

/**
 * Where the app keeps `hive` on a machine, under the login's home: one copy per version in
 * `.hivemind/bin/<version>/hive`, so apps of different versions never replace each other's, and
 * one folder per person in `.hivemind/people/<person>/` holding that person's terminal server and
 * sessions, so people who share a login never share, or stop, each other's terminals.
 */
const HIVE_HOME = ".hivemind";
/** Copies of other versions kept beside this one and any a process still runs. */
const KEEP_OTHER_VERSIONS = 2;

const isVersion = (v: string) => /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(v);

/** The folder name of the person `personId` (64 hex characters) under `.hivemind/people/`. */
export function personFolder(personId: string): string {
  if (!/^[0-9a-f]{16,}$/.test(personId)) throw new HiveError("person_invalid", "a person id is hex");
  return personId.slice(0, 16);
}

/** A remote shell command that runs `hive` `version` with `args` as person `person` (a `personFolder`):
 *  the terminal server it reaches or starts, and everything it keeps, are that person's. */
export function hiveThere(version: string, person: string, args: readonly string[]): string {
  if (!isVersion(version)) throw new HiveError("version_invalid", `not a version: ${JSON.stringify(version)}`);
  if (!/^[0-9a-f]{16}$/.test(person)) throw new HiveError("person_invalid", "not a person folder");
  // A socket named in the login's env would put everyone back in one server.
  return `unset HIVEMIND_PTY_SOCK; HIVEMIND_APP_DATA="$HOME/${HIVE_HOME}/people/${person}" exec "$HOME/${HIVE_HOME}/bin/${version}/hive"${args.map((a) => ` ${shq(a)}`).join("")}`;
}

/** Tagged lines, so a noisy remote shell profile cannot confuse the parser: the platform, the kind
 *  of computer, and the `hive` of `version` there when it is in place and runs. */
export function probeScript(version: string): string {
  if (!isVersion(version)) throw new HiveError("version_invalid", `not a version: ${JSON.stringify(version)}`);
  return shScript([
    `printf 'HIVEPROBE-UNAME %s %s\\n' "$(uname -s)" "$(uname -m)"`,
    KIND_SCRIPT,
    `p="$HOME/${HIVE_HOME}/bin/$1/hive"`,
    `if [ -x "$p" ] && [ "$("$p" --version 2>/dev/null | head -n1)" = "$1" ]; then printf 'HIVEPROBE-PATH %s\\n' "$p"; printf 'HIVEPROBE-VERSION %s\\n' "$1";`,
    `  if "$p" daemon --help 2>&1 | grep -q bridge; then printf 'HIVEPROBE-DAEMON yes\\n'; fi; fi`,
  ].join("\n"), version);
}

export function parseProbe(out: string): ProbeResult {
  const line = (tag: string) => out.split("\n").find((l) => l.startsWith(`HIVEPROBE-${tag} `))?.slice(`HIVEPROBE-${tag} `.length).trim();
  const uname = line("UNAME");
  if (!uname) throw new HiveError("machine_probe_failed", "remote did not answer the probe (is it a POSIX shell?)");
  const [os = "", arch = ""] = uname.split(" ");
  const platform = platformOf(os, arch);
  if (!platform) throw new HiveError("machine_unsupported", `unsupported remote platform '${uname}' — Linux or macOS on x86_64/arm64 only`);
  const hivePath = line("PATH");
  const kind = kindIn(out);
  const res: ProbeResult = { platform, ...(kind ? { kind } : {}) };
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
const INSTALL_HEAD = `set -e; d="$HOME/${HIVE_HOME}/bin/$1"; mkdir -p "$d"; tmp="$d/.hive.$$.tmp"; trap 'rm -f "$tmp"' EXIT`;
// Then the copies of other versions go, but the newest few and any a process here still runs.
const INSTALL_TAIL = [
  `chmod 755 "$tmp"; mv -f "$tmp" "$d/hive"; set +e`,
  `running=$(for e in /proc/[0-9]*/exe; do readlink "$e" 2>/dev/null; done)`,
  `n=0; for v in $(ls -t "$HOME/${HIVE_HOME}/bin"); do`,
  `  [ "$v" = "$1" ] && continue; n=$((n+1)); [ $n -le ${KEEP_OTHER_VERSIONS} ] && continue`,
  `  case "$running" in *"/${HIVE_HOME}/bin/$v/hive"*) continue ;; esac`,
  `  rm -rf "$HOME/${HIVE_HOME}/bin/$v"`,
  `done`,
  `printf '%s\\n' "$d/hive"`,
].join("\n");

/** Puts stdin there as `hive` `version`, only if exactly `bytes` arrived (a cut connection ends `cat` cleanly). */
export function installCopyCommand(version: string, bytes: number): string {
  if (!isVersion(version)) throw new HiveError("version_invalid", `not a version: ${JSON.stringify(version)}`);
  return shScript(`${INSTALL_HEAD}; cat > "$tmp"; n=$(wc -c < "$tmp"); [ $n -eq "$2" ] || { echo "received $n of $2 bytes" >&2; exit 1; }\n${INSTALL_TAIL}`, version, String(bytes));
}

/** Downloads `url` there as `hive` `version`. */
export function installFetchCommand(version: string, url: string): string {
  if (!isVersion(version)) throw new HiveError("version_invalid", `not a version: ${JSON.stringify(version)}`);
  return shScript(`${INSTALL_HEAD}; if command -v curl >/dev/null 2>&1; then curl -fsSL -o "$tmp" "$2"; elif command -v wget >/dev/null 2>&1; then wget -qO "$tmp" "$2"; else echo "neither curl nor wget is installed" >&2; exit 1; fi\n${INSTALL_TAIL}`, version, url);
}
