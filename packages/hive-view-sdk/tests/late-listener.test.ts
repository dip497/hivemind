// A listener added after the host said how things are (a widget's, which subscribes once its worker
// starts) is told the latest at once; one that says something happened is not repeated.
import { expect, test } from "bun:test";
import { fakeHost } from "../src/testing.js";

test("a late listener hears the workspace as it is now, and nothing that only happened", async () => {
  const host = fakeHost();
  const hm = await host.connect();
  host.send({ type: "structure", frames: [], tiles: [{ id: "t1", frameId: null, kind: "shell", name: "sh" }] });
  host.send({ type: "undock", tileId: "t1" });
  await host.settle();
  const tiles: string[][] = [];
  const undocks: string[] = [];
  hm.on("structure", (s) => tiles.push(s.tiles.map((t) => t.id)));
  hm.on("undock", (u) => undocks.push(u.tileId));
  expect(tiles).toEqual([["t1"]]);
  expect(undocks).toEqual([]);
  host.send({ type: "structure", frames: [], tiles: [] });
  await host.settle();
  expect(tiles).toEqual([["t1"], []]);
});
