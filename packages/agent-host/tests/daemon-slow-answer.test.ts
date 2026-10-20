// A daemon that is running but slow to answer is not "no daemon": asking it fails rather than
// reading the silence as none running, none to stop, or one that stopped.
import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { frame, makeLineDecoder, type ClientMsg } from "../src/pty-protocol.ts";
import { daemonProtocol, daemonSessions, retireDaemon, socketAt } from "../src/daemon-replace.ts";

const dir = fs.mkdtempSync("/tmp/hds-");
const servers: net.Server[] = [];
afterAll(() => { for (const s of servers) s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
const unix = process.platform !== "win32";

/** A daemon that answers only `list` (with no sessions) and stays silent to everything else. */
async function silentDaemon(name: string): Promise<string> {
  const sock = path.join(dir, name);
  const server = net.createServer((c) => {
    c.on("error", () => {});
    c.on("data", makeLineDecoder((text) => {
      const m = JSON.parse(text) as ClientMsg;
      if (m.t === "list" && name === "lists") c.write(frame({ t: "sessions", reqId: m.reqId, ids: [], detail: [] }));
    }));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(sock, r));
  return sock;
}

test.skipIf(!unix)("a daemon that does not say its protocol is an error, not no daemon", async () => {
  const sock = await silentDaemon("protocol");
  expect(await daemonProtocol(socketAt(path.join(dir, "none")), 200)).toBeNull();
  await expect(daemonProtocol(socketAt(sock), 200)).rejects.toThrow("did not answer");
});

test.skipIf(!unix)("a daemon that does not list its sessions is an error, not no sessions", async () => {
  const sock = await silentDaemon("sessions");
  expect(await daemonSessions(socketAt(path.join(dir, "none")), 200)).toEqual([]);
  await expect(daemonSessions(socketAt(sock), 200)).rejects.toThrow("did not answer");
});

test.skipIf(!unix)("a daemon still running after it was asked to stop fails its replacement", async () => {
  const sock = await silentDaemon("lists");
  await expect(retireDaemon(socketAt(sock), { waiting: () => {}, now: new Promise(() => {}) })).rejects.toThrow("still running");
}, 40_000);
