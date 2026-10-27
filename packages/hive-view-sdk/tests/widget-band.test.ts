// The widget band (protocol 1.18): a view hears how much of it the app's widget cards take, right
// after hello and on every change, so it can keep what it must show clear of them; a host that
// floats no cards over it never says, and the view keeps its own guess.
import { expect, test } from "bun:test";
import { fakeHost } from "../src/testing.js";
import type { ViewWidgetBand } from "../src/protocol.js";

test("a view hears the band right after hello and on each change; one listening later hears it at once", async () => {
  const host = fakeHost({ features: ["widgetBand"], widgetBand: { edge: "left", width: 268 } });
  const hm = await host.connect();
  const heard: ViewWidgetBand[] = [];
  const stop = hm.onWidgetBand((b) => heard.push(b));
  await host.settle();
  expect(heard).toEqual([{ edge: "left", width: 268 }]);
  // The cards took a second column; then a band that is no band is dropped, not heard.
  host.send({ type: "widgetBand", edge: "left", width: 520 });
  host.send({ type: "widgetBand", edge: "top", width: 40 } as never);
  await host.settle();
  expect(heard).toEqual([{ edge: "left", width: 268 }, { edge: "left", width: 520 }]);
  const late: ViewWidgetBand[] = [];
  hm.onWidgetBand((b) => late.push(b));
  expect(late).toEqual([{ edge: "left", width: 520 }]);
  // The cards went: 0, and a listener that stopped hears nothing more.
  stop();
  host.send({ type: "widgetBand", edge: "left", width: 0 });
  await host.settle();
  expect([heard.length, late]).toEqual([2, [{ edge: "left", width: 520 }, { edge: "left", width: 0 }]]);
});

test("a host without the feature (an app before 1.18, a phone) says no band, so the view keeps its own guess", async () => {
  const host = fakeHost({ features: [] });
  const hm = await host.connect();
  const heard: ViewWidgetBand[] = [];
  hm.onWidgetBand((b) => heard.push(b));
  await host.settle();
  expect([hm.supports("widgetBand"), heard]).toEqual([false, []]);
});
