// The daemon client (workspace-host/src/hive-net.ts) as main runs it, under Node: a device that
// stops lets go of its daemon quietly. Stopping destroys the socket the client is reading, which
// Node's stream reader answers with "Premature close"; unanswered, that was an unhandled rejection
// in main each time the app quit, or a joined workspace's host went. (Bun's reader does not throw
// here, so the package's own tests cannot see it.) Needs the daemon: cargo build in crates/hive-net.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HiveNet } from "@hivemind/workspace-host/hive-net";

const BIN = path.resolve(import.meta.dirname, "../../../../crates/hive-net/target/debug/hive-net");

test("a device that stops lets go of its daemon quietly: nothing is left failing behind it", { skip: !fs.existsSync(BIN) && "build hive-net first: cargo build in crates/hive-net" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-hive-net-"));
  const failures: unknown[] = [];
  const failed = (e: unknown) => failures.push(e);
  process.on("unhandledRejection", failed);
  try {
    fs.mkdirSync(path.join(root, "identity"));
    fs.writeFileSync(path.join(root, "identity", "device.key"), `${"ab".repeat(32)}\n`);
    const net = await HiveNet.start({ bin: BIN, identity: path.join(root, "identity"), socket: path.join(root, "net.sock"), onIncoming: () => {}, onPairRequest: async () => ({}) });
    net.stop();
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(failures.map(String), []);
  } finally {
    process.off("unhandledRejection", failed);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
