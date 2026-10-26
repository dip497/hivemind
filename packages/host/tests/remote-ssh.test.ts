import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bridgeRemoteCommand, sshCommand } from "../src/remote/ssh.ts";
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
