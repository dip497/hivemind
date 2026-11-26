// Typing into several terminals (protocol 1.21, feature `broadcast`): a view may ask for it only with
// `workspace:broadcast`, only on a host that has it, and only for tiles that are there; the host's
// word on the group reaches the view as a `broadcast` message.
import { expect, test } from "bun:test";
import { fakeHost } from "../src/testing.js";
import { parseHostMessage } from "../src/protocol.js";

const structure = { type: "structure", frames: [], tiles: [{ id: "t1", frameId: null, kind: "shell", name: "a" }, { id: "t2", frameId: null, kind: "shell", name: "b" }] } as const;

test("a group of tiles that are there is let through; one naming a tile that is not is refused", async () => {
  const host = fakeHost({ capabilities: ["workspace:broadcast"], features: ["broadcast"] });
  const hm = await host.connect();
  host.send(structure);
  await host.settle();
  hm.commands.broadcastInput(["t1", "t2"]);
  hm.commands.broadcastInput([]);
  hm.commands.broadcastInput(["t1", "t9"]);
  await host.settle();
  expect(host.commands.map((c) => c.args[0])).toEqual([["t1", "t2"], []]);
  expect(host.refused).toEqual(["broadcastInput: unknown tile"]);
});

test("a host without the feature refuses it, and a view without the permission cannot send it", async () => {
  const host = fakeHost({ capabilities: ["workspace:broadcast"], features: [] });
  const hm = await host.connect();
  host.send(structure);
  await host.settle();
  hm.commands.broadcastInput(["t1", "t2"]);
  await host.settle();
  expect(host.refused).toEqual(["broadcastInput: not supported"]);
  const bare = await fakeHost({ features: ["broadcast"] }).connect();
  expect(() => bare.commands.broadcastInput(["t1"])).toThrow();
});

test("the host's group reaches the view as ids; anything else is dropped", () => {
  expect(parseHostMessage({ type: "broadcast", tileIds: ["t1", "t2"] })).toEqual({ ok: true, msg: { type: "broadcast", tileIds: ["t1", "t2"] } });
  expect(parseHostMessage({ type: "broadcast", tileIds: [1] }).ok).toBe(false);
  expect(parseHostMessage({ type: "broadcast" }).ok).toBe(false);
});
