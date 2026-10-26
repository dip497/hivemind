// A stand-in `ssh` on PATH answers the probe per target; no network.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";

// Every `hive …` here is a fresh bun process (~0.4 s); the default 5 s is too tight.
setDefaultTimeout(60_000);
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hive, type Run } from "./helpers.js";
import { parseProbe, platformOf, sshArgv, shq } from "../src/remote.js";
import { defaultLabel } from "../src/commands/machine.js";
import { machineKeys } from "@hivemind/workspace-host/keyring";

const { version } = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string };

let tmp = "";
let env: Record<string, string> = {};
const run = (...args: string[]): Run => hive(args, { env });
const data = (r: Run) => (r.json as Record<string, unknown>);

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hive-machine-"));
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);
  // `good` has this version's hive, `arm` gets it downloaded there, `oldmac` has no release,
  // `down` refuses the connection (exit 255), and `shell` runs what it is sent in a home of its own.
  const rhome = path.join(tmp, "rhome");
  const there = path.join(rhome, ".hivemind", "bin", version);
  fs.mkdirSync(there, { recursive: true });
  fs.writeFileSync(path.join(there, "hive"), `#!/bin/sh
case "$1" in --version) echo ${version} ;; daemon) echo "bridge  connect to the terminal daemon" ;; *) echo "$* as $HIVEMIND_APP_DATA" ;; esac
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "ssh"), `#!/bin/sh
for a; do target_prev="$last"; last="$a"; done
case "$target_prev" in
  down) echo "ssh: connect to host down port 22: Connection refused" >&2; exit 255 ;;
  good) printf 'motd noise\\nHIVEPROBE-UNAME Linux aarch64\\nHIVEPROBE-KIND virtual-machine\\nHIVEPROBE-PATH /home/u/.hivemind/bin/${version}/hive\\nHIVEPROBE-VERSION ${version}\\nHIVEPROBE-DAEMON yes\\n' ;;
  arm) case "$last" in
    *releases/download*) printf '%s' "$last" > "${path.join(tmp, "installed")}"; echo /home/u/.hivemind/bin/${version}/hive ;;
    *) printf 'HIVEPROBE-UNAME Linux aarch64\\n'; if [ -f "${path.join(tmp, "installed")}" ]; then printf 'HIVEPROBE-PATH /home/u/.hivemind/bin/${version}/hive\\nHIVEPROBE-DAEMON yes\\n'; fi ;;
  esac ;;
  oldmac) printf 'HIVEPROBE-UNAME Darwin x86_64\\n' ;;
  shell) HOME=${rhome} PATH=/usr/bin:/bin exec sh -c "$last" ;;
  *)    printf 'HIVEPROBE-UNAME Linux x86_64\\n' ;;
esac
`);
  fs.chmodSync(path.join(bin, "ssh"), 0o755);
  env = { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, XDG_CONFIG_HOME: path.join(tmp, "xdg") };
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("hive machine", () => {
  test("add probes, records the absolute hive path, platform and kind of computer", () => {
    const r = run("machine", "add", "good", "--label", "gpu", "--json");
    expect(r.code).toBe(0);
    expect(data(r)).toMatchObject({ label: "gpu", target: "good", enabled: true, hivePath: `/home/u/.hivemind/bin/${version}/hive`, platform: "linux-arm64", kind: "virtual-machine", hiveVersion: version, installed: false });
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, "xdg", "hivemind", "machines.json"), "utf8"));
    expect(saved.machines).toHaveLength(1);
    expect(saved.machines[0].kind).toBe("virtual-machine");
    expect(fs.statSync(path.join(tmp, "xdg", "hivemind", "machines.json")).mode & 0o777).toBe(0o600);
  });

  test("a machine without this version's hive gets it, downloaded there, in a folder of that version", () => {
    const r = run("machine", "add", "arm", "--json");
    expect(r.json).toMatchObject({ target: "arm", platform: "linux-arm64", installed: true, hivePath: `/home/u/.hivemind/bin/${version}/hive` });
    const cmd = fs.readFileSync(path.join(tmp, "installed"), "utf8");
    expect(cmd).toContain(`'https://github.com/dip497/hivemind/releases/download/v${version}/hive-linux-arm64'`);
    expect(cmd.startsWith("sh -c ")).toBe(true);
    expect(run("machine", "remove", "arm", "--json").code).toBe(0);
  });

  test("a platform with no release is not saved, and says so", () => {
    const r = run("machine", "add", "oldmac", "--json");
    expect(r.json).toMatchObject({ error: { code: "MACHINE_INSTALL_UNAVAILABLE" } });
    expect((data(run("machine", "list", "--json")).machines as { target: string }[]).map((m) => m.target)).toEqual(["good"]);
  });

  test("a command sent to a machine runs this version's hive there as this person's", () => {
    expect(run("machine", "add", "shell", "--json").code).toBe(0);
    const r = run("ps", "--machine", "shell");
    const person = machineKeys(path.join(tmp, "xdg", "hivemind", "identity")).personId.slice(0, 16);
    expect(r.stdout.trim()).toBe(`ps as ${path.join(tmp, "rhome")}/.hivemind/people/${person}`);
    expect(run("machine", "remove", "shell", "--json").code).toBe(0);
  });

  test("an unreachable host is exit 3 and says to check plain ssh first", () => {
    const r = run("machine", "add", "down", "--json");
    expect(r.code).toBe(3);
    expect(r.json).toMatchObject({ error: { code: "MACHINE_UNREACHABLE" } });
    expect(String((r.json as { error: { message: string } }).error.message)).toContain("Connection refused");
  });

  test("an option-injection target is refused before ssh runs (exit 2)", () => {
    const r = run("machine", "add", "-oProxyCommand=touch /tmp/pwned", "--json");
    expect([1, 2]).toContain(r.code ?? -1); // citty may reject the leading dash itself
    expect(fs.existsSync("/tmp/pwned")).toBe(false);
    const r2 = run("machine", "add", "me:pw@host", "--json");
    expect(r2.code).toBe(2);
    expect(r2.json).toMatchObject({ error: { code: "MACHINE_TARGET_INVALID" } });
  });

  test("duplicate target, rename, disable/enable, remove", () => {
    expect(run("machine", "add", "good", "--json").json).toMatchObject({ error: { code: "MACHINE_EXISTS" } });
    const id = String((data(run("machine", "list", "--json")).machines as { id: string }[])[0]!.id);
    expect(run("machine", "rename", "gpu", "GPU box", "--json").code).toBe(0);
    expect(run("machine", "disable", "GPU box", "--json").code).toBe(0);
    const ps = run("ps", "--machine", "GPU box", "--json");
    expect(ps.json).toMatchObject({ error: { code: "MACHINE_DISABLED" } });
    expect(run("machine", "enable", id, "--json").code).toBe(0);
    expect(run("machine", "check", id, "--json").json).toMatchObject({ reachable: true, platform: "linux-arm64" });
    expect(run("machine", "remove", id, "--json").code).toBe(0);
    expect(data(run("machine", "list", "--json")).machines).toEqual([]);
    expect(run("machine", "remove", id, "--json").code).toBe(5);
  });
});

describe("remote helpers", () => {
  test("parseProbe ignores noise and rejects unsupported platforms", () => {
    expect(parseProbe("hi\nHIVEPROBE-UNAME Darwin arm64\n")).toEqual({ platform: "darwin-arm64" });
    expect(parseProbe("HIVEPROBE-UNAME Darwin arm64\nHIVEPROBE-KIND laptop\n")).toEqual({ platform: "darwin-arm64", kind: "laptop" });
    // A machine that does not say, or says something else, has no kind.
    expect(parseProbe("HIVEPROBE-UNAME Linux x86_64\nHIVEPROBE-KIND \n")).toEqual({ platform: "linux-x86_64" });
    expect(parseProbe("HIVEPROBE-UNAME Linux x86_64\nHIVEPROBE-KIND toaster\n")).toEqual({ platform: "linux-x86_64" });
    expect(() => parseProbe("HIVEPROBE-UNAME FreeBSD amd64\n")).toThrow(/unsupported/);
    expect(() => parseProbe("nothing\n")).toThrow(/did not answer/);
    expect(() => parseProbe("HIVEPROBE-UNAME Linux x86_64\nHIVEPROBE-PATH bin/hive\n")).toThrow(/relative/);
  });
  test("platformOf maps uname to release asset names", () => {
    expect(platformOf("Linux", "amd64")).toBe("linux-x86_64");
    expect(platformOf("Darwin", "x86_64")).toBe("darwin-x86_64");
    expect(platformOf("Linux", "riscv64")).toBeNull();
  });
  test("ssh argv: BatchMode for background, -t for interactive, ssh:// port, one quoted remote word", () => {
    expect(sshArgv("ssh://me@h:2200", "cmd", false)).toEqual(["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4", "-p", "2200", "me@h", "cmd"]);
    expect(sshArgv("box", "cmd", true).slice(0, 1)).toEqual(["-t"]);
    expect(shq("it's; rm -rf ~")).toBe(`'it'\\''s; rm -rf ~'`);
  });
  test("default label is the bare host", () => {
    expect(defaultLabel("ssh://me@gpu.lan:2222")).toBe("gpu.lan");
    expect(defaultLabel("me@build")).toBe("build");
  });
});
