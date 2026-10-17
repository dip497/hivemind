// A person who joined a workspace, without a window (M2's load gate): their device's own keys and
// hive-net daemon; let in with an invite link the host's person allows; then, as a guest's app
// does, their copy of the workspace kept in sync with the host's, and the host's workspace API.
import fs from "node:fs";
import path from "node:path";
import { machineKeys } from "@hivemind/workspace-host/keyring";
import { HiveNet, type Link } from "@hivemind/workspace-host/hive-net";
import { parseJoinLink } from "@hivemind/workspace-host/join-link";
import { replicate } from "@hivemind/workspace-host/doc-sync";
import { WorkspaceStore } from "@hivemind/workspace-host/store";
import type { WorkspaceChange } from "@hivemind/workspace-host/layout";
import { WorkspaceClient } from "@hivemind/workspace-api/client";
import { peerTransport, type TextChannel } from "@hivemind/workspace-api/peers";
import { HIVE_NET } from "./multiplayer";

const streamOf = (link: Link, stream: string): TextChannel => ({
  send: (text) => link.send(stream, text),
  on: (listener) => link.on(stream, listener),
  closed: link.closed,
});

export interface Guest {
  client: WorkspaceClient;
  /** Their copy of the workspace, which they may write as any replica may. */
  store: WorkspaceStore;
  /** The workspace as the host names it to peers: `hive://<id>`. */
  repo: string;
  stop(): void;
}

/** `name` joins with `invite` from `dir`, their device on the network by `bin`: `allow` lets them in
 *  at the host. Resolves once their copy of the workspace has caught up with the host's. */
export async function guest(dir: string, name: string, invite: string, allow: () => Promise<void>, bin = HIVE_NET): Promise<Guest> {
  const identity = path.join(dir, "identity");
  fs.mkdirSync(dir, { recursive: true });
  const { certificate } = machineKeys(identity);
  const net = await HiveNet.start({
    bin,
    identity,
    socket: path.join(dir, "net.sock"),
    onIncoming: (link) => link.close("nobody is served here"),
    onPairRequest: async () => ({ ok: false, error: "declined" }),
  });
  const link = parseJoinLink(invite)!;
  const asked = net.pair(link.host, link.where, { v: 1, workspace: link.workspace, secret: link.secret, certificate, profile: { name, color: "" } });
  await allow();
  const reply = (await asked) as { ok: boolean };
  if (!reply.ok) throw new Error(`${name} was not let in: ${JSON.stringify(reply)}`);
  const conn = await net.dial(link.host, link.where);
  const heard = new Set<(change: WorkspaceChange) => void>();
  const store = new WorkspaceStore({ dir: path.join(dir, "shared"), onChange: (c) => { for (const l of heard) l(c); } });
  const repo = `hive://${link.workspace}`;
  let stopSync = (): void => {};
  await new Promise<void>((resolve) => {
    stopSync = replicate(store, repo, streamOf(conn, "sync"), {
      workspace: link.workspace,
      changes: (listener) => { heard.add(listener); return () => { heard.delete(listener); }; },
      onWelcome: () => resolve(),
    });
  });
  return {
    client: new WorkspaceClient(peerTransport(streamOf(conn, "api"))),
    store,
    repo,
    stop: () => { stopSync(); conn.close("left"); net.stop(); },
  };
}
