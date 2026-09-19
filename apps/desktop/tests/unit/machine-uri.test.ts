import { test } from "node:test";
import assert from "node:assert/strict";
import { machineHostId, machineUri, parseRemote, sshTargetOf } from "../../src/shared/remote-uri.ts";
import { needsAttention } from "../../src/main/remote/ssh.ts";

test("a machine target becomes the frame uri at a path, for every target form", () => {
  assert.equal(machineUri("gpu-box", "/srv/app"), "ssh://gpu-box/srv/app");
  assert.equal(machineUri("me@10.0.0.5"), "ssh://me@10.0.0.5/");
  assert.equal(machineUri("ssh://me@host:2222", "work"), "ssh://me@host:2222/work");
  assert.equal(parseRemote(machineUri("ssh://me@host:2222", "/w")).port, 2222);
});

test("a frame finds its machine by host id, and a saved host maps to a target with the same id", () => {
  for (const t of [{ host: "box", port: 22, user: null }, { host: "box", port: 22, user: "me" }, { host: "box", port: 2222, user: "me" }]) {
    assert.equal(machineHostId(sshTargetOf(t)), parseRemote(`ssh://${t.user ? `${t.user}@` : ""}${t.host}:${t.port}/x`).hostId);
  }
  assert.equal(machineHostId("gpu-box"), parseRemote("ssh://gpu-box/any/path").hostId);
});

test("only failures a person must fix ask for attention", () => {
  assert.ok(needsAttention("me@box: Permission denied (publickey)."));
  assert.ok(needsAttention("Host key verification failed."));
  assert.ok(needsAttention("@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@"));
  assert.ok(!needsAttention("ssh: connect to host box port 22: Connection refused"));
  assert.ok(!needsAttention("ssh: Could not resolve hostname box: Name or service not known"));
});
