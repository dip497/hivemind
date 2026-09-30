import { test } from "node:test";
import assert from "node:assert/strict";
import { bindToMachine, machineHostId, machineUri, parseMachineUri, parseRemote, sshTargetOf, sshUri, unbindFromMachine } from "@hivemind/core/remote-uri";
import { needsAttention } from "../src/remote/ssh.ts";

test("a folder on a saved machine is named by the machine's id; its path is the rest", () => {
  assert.equal(machineUri("m_3f9a0c12b7de", "/srv/app"), "machine://m_3f9a0c12b7de/srv/app");
  assert.equal(machineUri("m_1", "work"), "machine://m_1/work");
  assert.deepEqual(parseMachineUri("machine://m_1/srv/app"), { machineId: "m_1", path: "/srv/app" });
  assert.deepEqual(parseMachineUri("machine://m_1"), { machineId: "m_1", path: "/" });
  assert.equal(parseMachineUri("machine:///srv"), null);
  assert.equal(parseMachineUri("ssh://m_1/srv"), null);
});

test("a machine's address becomes the ssh uri it is reached at, for every target form", () => {
  assert.equal(sshUri("gpu-box", "/srv/app"), "ssh://gpu-box/srv/app");
  assert.equal(sshUri("me@10.0.0.5"), "ssh://me@10.0.0.5/");
  assert.equal(sshUri("ssh://me@host:2222", "work"), "ssh://me@host:2222/work");
  assert.equal(parseRemote(sshUri("ssh://me@host:2222", "/w")).port, 2222);
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

test("a folder bound by a saved machine's address is bound to the machine; any other stays as it is", () => {
  const box = { id: "m_1", target: "me@box", hostId: "me@box:22" };
  const other = { id: "m_2", target: "ssh://ops@gpu:2222", hostId: "ops@gpu:2222" };
  assert.equal(bindToMachine("ssh://me@box/srv/app", [other, box]), "machine://m_1/srv/app");
  assert.equal(bindToMachine("ssh://me@box:22/srv", [box]), "machine://m_1/srv");
  assert.equal(bindToMachine("ssh://ops@gpu:2222/w", [box, other]), "machine://m_2/w");
  assert.equal(bindToMachine("ssh://you@box/srv", [box]), "ssh://you@box/srv");
  assert.equal(bindToMachine("machine://m_9/srv", [box]), "machine://m_9/srv");
  assert.equal(bindToMachine("/home/me/app", [box]), "/home/me/app");
  assert.equal(bindToMachine(undefined, [box]), undefined);
});

test("a folder on a machine no longer saved goes back to its address; one on another machine stays", () => {
  const box = { id: "m_1", target: "ssh://me@box:2222", hostId: "me@box:2222" };
  assert.equal(unbindFromMachine("machine://m_1/srv/app", box), "ssh://me@box:2222/srv/app");
  assert.equal(unbindFromMachine("machine://m_2/srv/app", box), "machine://m_2/srv/app");
  assert.equal(unbindFromMachine("ssh://me@box:2222/srv", box), "ssh://me@box:2222/srv");
  assert.equal(unbindFromMachine(undefined, box), undefined);
});
