// A plugin's commands (protocol 1.10): what its manifest declares, and what `hm.onCommand` answers
// when the host invokes one: the handler's result, its error, or that nothing answers that name.
import { expect, test } from "bun:test";
import { fakeHost } from "../src/testing.js";
import { parsePluginCommands } from "../src/commands.js";
import { validateViewManifest } from "../src/manifest.js";

test("a manifest's commands are named, described, and say what they take; anything else is refused", () => {
  expect(parsePluginCommands([{ name: "add-item", description: "Add an item.", args: '{ "text": string }' }]))
    .toEqual({ commands: [{ name: "add-item", description: "Add an item.", args: '{ "text": string }' }] });
  expect(parsePluginCommands(undefined)).toEqual({ commands: [] });
  for (const bad of [[{ name: "Add", description: "x" }], [{ name: "add" }], [{ name: "a", description: "x" }, { name: "a", description: "y" }], "add"]) {
    expect("error" in parsePluginCommands(bad)).toBe(true);
  }
  const m = validateViewManifest({ id: "board", name: "B", version: "1.0.0", entry: "index.html", permissions: [], commands: [{ name: "count", description: "How many." }] });
  expect(m.ok && m.manifest.commands).toEqual([{ name: "count", description: "How many." }]);
});

test("an invoked command is answered with what its handler returns, or throws; a name nothing answers says so", async () => {
  const host = fakeHost({});
  const hm = await host.connect();
  const items: string[] = [];
  hm.onCommand("add", async (args) => { items.push((args as { text: string }).text); return { count: items.length }; });
  hm.onCommand("fail", () => { throw new Error("not today"); });
  host.send({ type: "invoke", invokeId: 1, name: "add", args: { text: "milk" } });
  host.send({ type: "invoke", invokeId: 2, name: "fail", args: null });
  host.send({ type: "invoke", invokeId: 3, name: "nope", args: null });
  // A name nothing answers waits a moment for its handler, then says so.
  for (let i = 0; i < 40 && host.received.filter((m) => m.type === "invokeResult").length < 3; i++) await new Promise((r) => setTimeout(r, 50));
  expect(items).toEqual(["milk"]);
  expect(host.received.filter((m) => m.type === "invokeResult")).toEqual([
    { type: "invokeResult", invokeId: 1, ok: true, result: { count: 1 } },
    { type: "invokeResult", invokeId: 2, ok: false, error: "not today" },
    { type: "invokeResult", invokeId: 3, ok: false, error: 'it does not answer "nope" now' },
  ]);
  expect(host.refused).toEqual([]);
});

test("the example view in the repository is a view this app loads, with its commands", async () => {
  const raw = JSON.parse(await Bun.file(new URL("../../../examples/views/agent-board/hivemind-view.json", import.meta.url)).text());
  const m = validateViewManifest(raw);
  expect(m.ok && m.manifest.commands.map((c) => c.name)).toEqual(["post", "list", "clear"]);
});

test("a call that arrives before its handler is registered (the plugin has just connected) is answered by it", async () => {
  const host = fakeHost({});
  const hm = await host.connect();
  host.send({ type: "invoke", invokeId: 9, name: "late", args: null });
  await new Promise((r) => setTimeout(r, 120));
  hm.onCommand("late", () => "here");
  for (let i = 0; i < 20 && !host.received.some((m) => m.type === "invokeResult"); i++) await new Promise((r) => setTimeout(r, 50));
  expect(host.received.filter((m) => m.type === "invokeResult")).toEqual([{ type: "invokeResult", invokeId: 9, ok: true, result: "here" }]);
});
