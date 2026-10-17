// What a daemon's starter names as handed down is let go of, and nothing else: a socket named is
// closed, so its peer hears the end; one named under another socket's name stays open.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { dropHandedDown } from "@hivemind/agent-host/handed-down";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hhd-"));
const server = net.createServer();
const opened: net.Socket[] = [];
after(() => { for (const s of opened) s.destroy(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

/** A connected pair: our end's descriptor and its name here, and whether its peer heard the end. */
async function pair() {
  const accepted = new Promise<net.Socket>((r) => server.once("connection", r));
  const ours = net.connect(path.join(dir, "s.sock"));
  await new Promise((r) => ours.once("connect", r));
  const peer = await accepted;
  opened.push(peer);
  const ended = new Promise<"ended">((r) => peer.once("end", () => r("ended")));
  peer.resume();
  const fd = (ours as unknown as { _handle: { fd: number } })._handle.fd;
  return { ours, fd, name: fs.readlinkSync(`/proc/self/fd/${fd}`), ended };
}

test("a socket named as handed down is closed, and one named under another's name is left open", { skip: process.platform !== "linux" }, async () => {
  await new Promise<void>((r) => server.listen(path.join(dir, "s.sock"), r));
  const named = await pair();
  const other = await pair();
  // Ours of the named pair is closed under node's feet: node lets go of it, never closes it again.
  named.ours.unref();
  opened.push(other.ours);
  dropHandedDown(JSON.stringify([[named.fd, named.name], [other.fd, named.name], [1, "pipe:[1]"]]));
  const wait = (p: Promise<"ended">) => Promise.race([p, new Promise((r) => setTimeout(() => r("open"), 1_000))]);
  assert.equal(await wait(named.ended), "ended");
  assert.equal(await wait(other.ended), "open");
  assert.equal(fs.readlinkSync(`/proc/self/fd/${other.fd}`), other.name);
});
