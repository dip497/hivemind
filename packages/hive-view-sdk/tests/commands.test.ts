// A plugin's commands (protocol 1.10): what its manifest declares, and what `hm.onCommand` answers
// when the host invokes one: the handler's result, its error, or that nothing answers that name.
import { expect, test } from "bun:test";
import { fakeHost } from "../src/testing.js";
import { chordMatches, parsePluginCommands } from "../src/commands.js";
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


const press = (key: string, code: string, mods: { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean } = {}) =>
  ({ key, code, ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, altKey: !!mods.alt, shiftKey: !!mods.shift });

test("a command's keys are modifiers and one key the terminals and the app leave free; any other, or the same keys twice, are refused", () => {
  expect(parsePluginCommands([{ name: "split", description: "Split.", keys: "mod+\\" }])).toEqual({ commands: [{ name: "split", description: "Split.", keys: "mod+\\" }] });
  for (const keys of ["k", "shift+k", "mod+", "mod+k+j", "mod+mod+k", "mod+banana", 3]) {
    expect("error" in parsePluginCommands([{ name: "a", description: "x", keys }])).toBe(true);
  }
  // What a terminal or the app answers is never a plugin's: interrupt, end of input, copy and paste,
  // a cursor move, zoom, Escape, a shell's meta key.
  for (const keys of ["mod+c", "ctrl+d", "ctrl+shift+v", "mod+1", "mod+arrowleft", "mod+=", "mod+[", "mod+enter", "mod+alt+escape", "alt+x", "mod+shift+tab"]) {
    expect(["error", keys] as unknown).toEqual(["error" in parsePluginCommands([{ name: "a", description: "x", keys }]) ? "error" : "accepted", keys]);
  }
  for (const keys of ["mod+shift+\\", "mod+shift+enter", "mod+alt+arrowleft", "mod+alt+k", "ctrl+]"]) {
    expect(["accepted", keys] as unknown).toEqual(["error" in parsePluginCommands([{ name: "a", description: "x", keys }]) ? "error" : "accepted", keys]);
  }
  // Nor is one matched, whatever a manifest says.
  expect(chordMatches("mod+c", press("c", "KeyC", { ctrl: true }), false)).toBe(false);
  expect("error" in parsePluginCommands([{ name: "a", description: "x", keys: "mod+k" }, { name: "b", description: "y", keys: "MOD+K" }])).toBe(true);
});

test("keys are matched by the key pressed, whatever shift makes of it; mod is Cmd on a Mac and Ctrl elsewhere", () => {
  expect(chordMatches("mod+shift+\\", press("|", "Backslash", { ctrl: true, shift: true }), false)).toBe(true);
  expect(chordMatches("mod+shift+\\", press("|", "Backslash", { meta: true, shift: true }), true)).toBe(true);
  expect(chordMatches("mod+shift+\\", press("|", "Backslash", { ctrl: true, shift: true }), true)).toBe(false);
  expect(chordMatches("mod+\\", press("\\", "Backslash", { ctrl: true, shift: true }), false)).toBe(false);
  expect(chordMatches("mod+alt+arrowleft", press("ArrowLeft", "ArrowLeft", { ctrl: true, alt: true }), false)).toBe(true);
  expect(chordMatches("mod+alt+k", press("˚", "KeyK", { ctrl: true, alt: true }), false)).toBe(true);
  expect(chordMatches("mod+alt+k", press("k", "KeyJ", { ctrl: true, alt: true }), false)).toBe(false);
});

test("keys the host names in hello run their command while focus is in the view", async () => {
  const host = fakeHost({ keys: [{ keys: "mod+\\", command: "split" }] });
  const hm = await host.connect();
  let ran = 0;
  hm.onCommand("split", () => { ran++; });
  const key = (k: string, code: string, ctrl: boolean) => {
    const e = new Event("keydown", { cancelable: true });
    Object.assign(e, { key: k, code, ctrlKey: ctrl, metaKey: false, altKey: false, shiftKey: false });
    globalThis.dispatchEvent(e);
    return e.defaultPrevented;
  };
  expect(key("\\", "Backslash", true)).toBe(true);
  expect(key("\\", "Backslash", false)).toBe(false);
  await new Promise((r) => setTimeout(r, 0));
  expect(ran).toBe(1);
});
