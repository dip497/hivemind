import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bridgeRemoteCommand, plainTerminalCommand, probeMachine, sshCommand } from "../src/remote/ssh.ts";
import type { RemoteTarget } from "@hivemind/core/remote-uri";

const target = (over: Partial<RemoteTarget> = {}): RemoteTarget => ({ host: "gpu", port: 2222, user: "me", path: "/srv", hostId: "me@gpu:2222", ...over });
const paths = { knownHosts: "/cfg/hivemind/known_hosts", controlDir: "/run/user/1/hivemind-ssh-1", askpass: "/cfg/hivemind/hive-askpass" };

test("key auth: batch mode, tofu into the app's known_hosts, shared connection, destination last", () => {
  const c = sshCommand(target(), { privateKeyPath: "/k/id_ed25519" }, paths, "CMD");
  assert.deepEqual(c.args, [
    "-T", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4",
    "-o", "Compression=yes",
    "-o", "StrictHostKeyChecking=accept-new", "-o", "UserKnownHostsFile=/cfg/hivemind/known_hosts ~/.ssh/known_hosts",
    "-i", "/k/id_ed25519",
    "-o", "ControlMaster=auto", "-o", "ControlPath=/run/user/1/hivemind-ssh-1/%C", "-o", "ControlPersist=60",
    "-o", "BatchMode=yes",
    "-p", "2222", "me@gpu", "CMD",
  ]);
  assert.deepEqual(c.env, {});
});

test("a saved password is answered by askpass from the env, never on the command line", () => {
  const c = sshCommand(target(), { password: "s3cret", username: "ops" }, paths, "CMD");
  assert.ok(!c.args.includes("BatchMode=yes"));
  assert.ok(!c.args.join(" ").includes("s3cret"));
  assert.deepEqual(c.env, { SSH_ASKPASS: paths.askpass, SSH_ASKPASS_REQUIRE: "force", HIVE_SSH_PASSWORD: "s3cret" });
  assert.equal(c.args.at(-2), "ops@gpu", "the saved username wins over the URI's");
});

test("the default port is left to the ssh config, so an alias with its own Port works", () => {
  const c = sshCommand(target({ host: "gpu-alias", port: 22, user: null }), {}, paths, "CMD");
  assert.ok(!c.args.includes("-p"));
  assert.deepEqual(c.args.slice(-2), ["gpu-alias", "CMD"]);
});

test("paths with spaces are quoted for ssh's option parser", () => {
  const c = sshCommand(target(), {}, { knownHosts: "/Users/me/Library/Application Support/hivemind/known_hosts" }, "CMD");
  assert.ok(c.args.includes('UserKnownHostsFile="/Users/me/Library/Application Support/hivemind/known_hosts" ~/.ssh/known_hosts'));
  assert.ok(!c.args.includes("ControlMaster=auto"), "no control socket without a control dir");
});

test("a host or user that would read as an ssh option is refused", () => {
  assert.throws(() => sshCommand(target({ host: "-oProxyCommand=touch /tmp/x" }), {}, paths, "CMD"), /invalid ssh host/);
  assert.throws(() => sshCommand(target({ user: null }), { username: "-oProxyCommand=x" }, paths, "CMD"), /invalid ssh host/);
  assert.throws(() => sshCommand(target({ host: "gpu box" }), {}, paths, "CMD"), /invalid ssh host/);
});

test("the bridge runs this version's hive, in a login shell, as the person's own", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hive-bridge-"));
  try {
    const at = path.join(home, ".hivemind", "bin", "2026.10.6");
    fs.mkdirSync(at, { recursive: true });
    fs.writeFileSync(path.join(at, "hive"), `#!/bin/sh\necho "$* for $HIVEMIND_APP_DATA"\n`, { mode: 0o755 });
    const out = execFileSync("sh", ["-c", bridgeRemoteCommand("2026.10.6", "0123456789abcdef")], { env: { PATH: "/usr/bin:/bin", HOME: home }, encoding: "utf8" });
    assert.equal(out.trim(), `daemon bridge for ${home}/.hivemind/people/0123456789abcdef`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("over plain ssh a terminal runs its program in its folder, each word as given", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "it's a folder-"));
  try {
    const out = execFileSync("sh", ["-c", plainTerminalCommand(folder, "printf", ["%s|", "a b", "it's", "$HOME"], false)], { encoding: "utf8", cwd: os.tmpdir() });
    assert.equal(out, "a b|it's|$HOME|");
    assert.equal(execFileSync("sh", ["-c", plainTerminalCommand(folder, "pwd", [], false)], { encoding: "utf8" }).trim(), fs.realpathSync(folder));
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

/** The script a Windows command line carries, as PowerShell decodes it. */
const scriptOf = (command: string) => Buffer.from(command.split(" ").at(-1)!, "base64").toString("utf16le");

test("on Windows a terminal is one command line cmd and PowerShell both pass on untouched, its script quoting every word", () => {
  const c = plainTerminalCommand("/C:/Users/me/it's here", "claude", ["--name", "a b", "$env:SECRET; calc"], true);
  // Nothing in it either shell reads: letters, digits and base64.
  assert.match(c, /^powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand [A-Za-z0-9+/=]+$/);
  assert.equal(scriptOf(c), "Set-Location -LiteralPath 'C:\\Users\\me\\it''s here'; & 'claude' '--name' 'a b' '$env:SECRET; calc'; exit $LASTEXITCODE");
  // A typographic quote is a quote to PowerShell: doubled, as ' is.
  assert.equal(scriptOf(plainTerminalCommand("/C:/it’s", "claude", ["‘x’; calc"], true)), "Set-Location -LiteralPath 'C:\\it’’s'; & 'claude' '‘‘x’’; calc'; exit $LASTEXITCODE");
  // A shell named as on Linux is PowerShell there.
  assert.equal(scriptOf(plainTerminalCommand("/C:/work", "/bin/bash", ["-il"], true)), "Set-Location -LiteralPath 'C:\\work'; & 'powershell.exe' '-NoLogo'; exit $LASTEXITCODE");
});

test("a machine whose ssh is not a POSIX shell is asked again as Windows, and read as one", async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "hive-win-ssh-"));
  try {
    // ssh to a Windows PC whose shell is cmd: `sh` is not there; PowerShell answers in CRLF lines.
    fs.writeFileSync(path.join(bin, "ssh"), [
      "#!/bin/sh",
      'for last; do :; done',
      'case "$last" in',
      "  sh\\ -c*) echo \"'sh' is not recognized as an internal or external command\" >&2; exit 1 ;;",
      "  powershell*) printf 'HIVEPROBE-UNAME Windows AMD64\\r\\nHIVEPROBE-KIND laptop\\r\\n' ;;",
      "  *) exit 2 ;;",
      "esac",
      "",
    ].join("\n"), { mode: 0o755 });
    const before = process.env.PATH;
    process.env.PATH = `${bin}:${before}`;
    try {
      assert.deepEqual(await probeMachine(target(), {}, paths, "2026.10.8"), { platform: "windows-x64", kind: "laptop" });
    } finally {
      process.env.PATH = before;
    }
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});
