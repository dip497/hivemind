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

let tmp = "";
let env: Record<string, string> = {};
const run = (...args: string[]): Run => hive(args, { env });
const data = (r: Run) => (r.json as { data: Record<string, unknown> }).data;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hive-machine-"));
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);
  // `good` has hive, `bare` does not, `down` refuses the connection (exit 255).
  fs.writeFileSync(path.join(bin, "ssh"), `#!/bin/sh
for a; do target_prev="$last"; last="$a"; done
case "$target_prev" in
  down) echo "ssh: connect to host down port 22: Connection refused" >&2; exit 255 ;;
  good) printf 'motd noise\\nHIVEPROBE-UNAME Linux aarch64\\nHIVEPROBE-PATH /home/u/.local/bin/hive\\nHIVEPROBE-VERSION 1.17.0\\nHIVEPROBE-DAEMON yes\\n' ;;
  arm) case "$last" in
    *releases/download*) printf '%s' "$last" > "${path.join(tmp, "installed")}"; echo /home/u/.local/bin/hive ;;
    *) printf 'HIVEPROBE-UNAME Linux aarch64\\n'; if [ -f "${path.join(tmp, "installed")}" ]; then printf 'HIVEPROBE-PATH /home/u/.local/bin/hive\\nHIVEPROBE-DAEMON yes\\n'; fi ;;
  esac ;;
  oldmac) printf 'HIVEPROBE-UNAME Darwin x86_64\\n' ;;
  oldhive) printf 'HIVEPROBE-UNAME Linux x86_64\\nHIVEPROBE-PATH /usr/local/bin/hive\\nHIVEPROBE-VERSION 1.16.0\\n' ;;
  *)    printf 'HIVEPROBE-UNAME Linux x86_64\\n' ;;
esac
`);
  fs.chmodSync(path.join(bin, "ssh"), 0o755);
  env = { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, XDG_CONFIG_HOME: path.join(tmp, "xdg") };
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("hive machine", () => {
  test("add probes, records the absolute hive path and platform", () => {
    const r = run("machine", "add", "good", "--label", "gpu", "--json");
    expect(r.code).toBe(0);
    expect(data(r)).toMatchObject({ label: "gpu", target: "good", enabled: true, hivePath: "/home/u/.local/bin/hive", platform: "linux-arm64", hiveVersion: "1.17.0", installed: false });
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, "xdg", "hivemind", "machines.json"), "utf8"));
    expect(saved.machines).toHaveLength(1);
    expect(fs.statSync(path.join(tmp, "xdg", "hivemind", "machines.json")).mode & 0o777).toBe(0o600);
  });

  test("a host without hive is not saved unless --install", () => {
    const r = run("machine", "add", "bare", "--json");
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ ok: false, code: "machine_no_hive" });
    expect(data(run("machine", "list", "--json"))).toHaveLength(1);
  });

  test("--install on another platform has the remote download this version's release asset", () => {
    const r = run("machine", "add", "arm", "--install", "--json");
    expect(r.json).toMatchObject({ ok: true, data: { target: "arm", platform: "linux-arm64", installed: true } });
    const cmd = fs.readFileSync(path.join(tmp, "installed"), "utf8");
    const { version } = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string };
    expect(cmd).toContain(`'https://github.com/dip497/hivemind/releases/download/v${version}/hive-linux-arm64'`);
    expect(cmd.startsWith("sh -c ")).toBe(true);
    expect(run("machine", "remove", "arm", "--json").code).toBe(0);
  });

  test("a hive too old to run the daemon counts as missing", () => {
    const r = run("machine", "add", "oldhive", "--json");
    expect(r.json).toMatchObject({ ok: false, code: "machine_no_hive" });
    expect(String((r.json as { error: string }).error)).toContain("too old");
  });

  test("--install for a platform with no release says so", () => {
    const r = run("machine", "add", "oldmac", "--install", "--json");
    expect(r.json).toMatchObject({ ok: false, code: "machine_install_unavailable" });
  });

  test("an unreachable host is exit 3 and says to check plain ssh first", () => {
    const r = run("machine", "add", "down", "--json");
    expect(r.code).toBe(3);
    expect(r.json).toMatchObject({ ok: false, code: "machine_unreachable" });
    expect(String((r.json as { error: string }).error)).toContain("Connection refused");
  });

  test("an option-injection target is refused before ssh runs (exit 2)", () => {
    const r = run("machine", "add", "-oProxyCommand=touch /tmp/pwned", "--json");
    expect([1, 2]).toContain(r.code ?? -1); // citty may reject the leading dash itself
    expect(fs.existsSync("/tmp/pwned")).toBe(false);
    const r2 = run("machine", "add", "me:pw@host", "--json");
    expect(r2.code).toBe(2);
    expect(r2.json).toMatchObject({ code: "machine_target_invalid" });
  });

  test("duplicate target, rename, disable/enable, remove", () => {
    expect(run("machine", "add", "good", "--json").json).toMatchObject({ code: "machine_exists" });
    const id = String((data(run("machine", "list", "--json")) as unknown as { id: string }[])[0]!.id);
    expect(run("machine", "rename", "gpu", "GPU box", "--json").code).toBe(0);
    expect(run("machine", "disable", "GPU box", "--json").code).toBe(0);
    const ps = run("ps", "--machine", "GPU box", "--json");
    expect(ps.json).toMatchObject({ ok: false, code: "machine_disabled" });
    expect(run("machine", "enable", id, "--json").code).toBe(0);
    expect(run("machine", "check", id, "--json").json).toMatchObject({ ok: true, data: { reachable: true, platform: "linux-arm64" } });
    expect(run("machine", "remove", id, "--json").code).toBe(0);
    expect(data(run("machine", "list", "--json"))).toEqual([]);
    expect(run("machine", "remove", id, "--json").code).toBe(5);
  });
});

describe("remote helpers", () => {
  test("parseProbe ignores noise and rejects unsupported platforms", () => {
    expect(parseProbe("hi\nHIVEPROBE-UNAME Darwin arm64\n")).toEqual({ platform: "darwin-arm64" });
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
