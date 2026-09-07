// The client against a scripted host over a real MessageChannel.
import { describe, expect, test } from "bun:test";
import { connect } from "../src/client.js";
import { PORT_HANDSHAKE, type PluginMessage } from "../src/protocol.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

async function scriptedHost(capabilities: string[] = []) {
  const target = new EventTarget() as unknown as Window;
  const ch = new MessageChannel();
  const inbox: PluginMessage[] = [];
  ch.port1.onmessage = (e) => {
    inbox.push(e.data as PluginMessage);
    if ((e.data as PluginMessage).type === "ready") {
      ch.port1.postMessage({ type: "hello", v: 1, pluginId: "p", capabilities, theme: { colors: { bg: "#000000" } }, layout: { saved: 1 }, viewport: { w: 800, h: 600 }, visible: true });
    }
  };
  ch.port1.start();
  const pending = connect({ target, timeoutMs: 2000 });
  target.dispatchEvent(new MessageEvent("message", { data: { type: PORT_HANDSHAKE }, ports: [ch.port2] }));
  const client = await pending;
  const send = (m: unknown) => ch.port1.postMessage(m);
  return { client, inbox, send };
}

describe("view-sdk client", () => {
  test("handshake → ready → hello, then events + status subscription refcount", async () => {
    const { client, inbox, send } = await scriptedHost();
    expect(inbox[0]).toEqual({ type: "ready", v: 1 });
    expect(client.hello.layout).toEqual({ saved: 1 });
    expect(client.viewport).toEqual({ w: 800, h: 600 });

    const seen: unknown[] = [];
    client.on("structure", (m) => seen.push(m.tiles.length));
    send({ type: "structure", frames: [], tiles: [{ id: "t1", frameId: null, kind: "shell", name: "sh" }] });
    await tick();
    expect(seen).toEqual([1]);

    const statuses: string[] = [];
    const off1 = client.subscribeStatus("t1", (s) => statuses.push(`a:${s}`));
    const off2 = client.subscribeStatus("t1", (s) => statuses.push(`b:${s}`));
    await tick();
    expect(inbox.filter((m) => m.type === "subscribeStatus")).toHaveLength(1);
    send({ type: "status", tileId: "t1", status: "working" });
    await tick();
    expect(statuses).toEqual(["a:working", "b:working"]);
    off1();
    await tick();
    expect(inbox.filter((m) => m.type === "unsubscribeStatus")).toHaveLength(0);
    off2();
    await tick();
    expect(inbox.filter((m) => m.type === "unsubscribeStatus")).toHaveLength(1);
  });

  test("commands are gated by granted permissions; surface rects are deduplicated", async () => {
    const { client, inbox } = await scriptedHost([]);
    client.commands.selectTile("t1");
    expect(() => client.commands.addFrame()).toThrow(/workspace:spawn/);
    client.setSurfaceRects([{ tileId: "t1", x: 1.2, y: 2.7, w: 10, h: 10 }]);
    client.setSurfaceRects([{ tileId: "t1", x: 1.4, y: 2.6, w: 10, h: 10 }]); // same after rounding
    await tick();
    expect(inbox.filter((m) => m.type === "command")).toEqual([{ type: "command", name: "selectTile", args: ["t1"] }]);
    expect(inbox.filter((m) => m.type === "surfaceRects")).toEqual([{ type: "surfaceRects", rects: [{ tileId: "t1", x: 1, y: 3, w: 10, h: 10 }] }]);
  });

  test("reveal round-trips through the handler; malformed host messages are dropped", async () => {
    const { client, inbox, send } = await scriptedHost();
    client.onReveal((id) => (id === "t1" ? { x: 5, y: 6, w: 7, h: 8 } : null));
    send({ type: "reveal", requestId: 9, tileId: "t1" });
    send({ type: "status", tileId: "t1", status: "purple" });
    send({ type: "selection", tileId: "t1" });
    await tick(); await tick();
    expect(inbox.filter((m) => m.type === "revealed")).toEqual([{ type: "revealed", requestId: 9, rect: { x: 5, y: 6, w: 7, h: 8 } }]);
  });
});
