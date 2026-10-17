// The widgets feature (protocol 1.8): a view is sent every widget in the workspace once it asks,
// again whenever one changes, and may press one when its manifest asked to (a widget's button can
// do whatever the widget may); a host that did not wire it sends nothing and takes no press.
import { expect, test } from "bun:test";
import { fakeHost } from "../src/testing.js";
import type { ViewWidget } from "../src/protocol.js";

const pet: ViewWidget = { id: "w1", widget: "@ada/pet", name: "Pet", tree: { type: "button", label: "Pat", action: "pat" }, card: false, images: {}, placement: "screen" };

test("a view hears the workspace's widgets and presses one as a person would", async () => {
  const host = fakeHost({ features: ["widgets"], capabilities: ["workspace:widgets"] });
  const hm = await host.connect();
  const heard: ViewWidget[][] = [];
  const stop = hm.onWidgets((w) => heard.push(w));
  await host.settle();
  expect(host.subscribed.widgets).toBe(true);
  host.send({ type: "widgets", widgets: [pet] });
  await host.settle();
  expect(heard).toEqual([[pet]]);
  hm.pressWidget("w1", "pat");
  hm.clickWidget("w1");
  await host.settle();
  expect(host.pressed).toEqual([{ id: "w1", action: "pat" }, { id: "w1", click: true }]);
  stop();
  await host.settle();
  expect(host.subscribed.widgets).toBe(false);
});

test("a view that did not ask to press widgets may see them, not press them", async () => {
  const host = fakeHost({ features: ["widgets"] });
  const hm = await host.connect();
  hm.onWidgets(() => {});
  expect(() => hm.pressWidget("w1", "pat")).toThrow('needs permission "workspace:widgets"');
  // One that sends it anyway, past the client, is refused by the host.
  await host.settle();
  expect(host.subscribed.widgets).toBe(true);
  expect(host.pressed).toEqual([]);
});

test("a host without widgets is asked for none, and takes no press", async () => {
  const host = fakeHost({ features: [], capabilities: ["workspace:widgets"] });
  const hm = await host.connect();
  hm.onWidgets(() => {});
  hm.pressWidget("w1", "pat");
  await host.settle();
  expect(host.subscribed.widgets).toBe(false);
  expect(host.pressed).toEqual([]);
  expect(host.refused).toEqual([]);
});
