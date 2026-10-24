// A widget's icon is an image from its own folder, named in its widget.json; one that names no
// image there has none, and a built-in carries its own the same way.
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BUILTIN_WIDGETS, tintProblem, widgetTree } from "./widget-format.js";
import { readWidget } from "./widgets.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function widget(meta: object, files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hm-widget-"));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, "widget.json"), JSON.stringify({ name: "W", draw: { type: "text", text: "w" }, ...meta }));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

test("its icon is the image its widget.json names from its folder, and nothing else", async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/></svg>';
  expect((await readWidget(widget({ icon: "icon.svg" }, { "icon.svg": svg }))).icon).toStartWith("data:image/svg+xml;base64,");
  expect((await readWidget(widget({ icon: "missing.png" }))).icon).toBeUndefined();
  // A name that is no file of its own, an object's own property included, gives no icon.
  expect((await readWidget(widget({ icon: "constructor" }))).icon).toBeUndefined();
  expect((await readWidget(widget({ icon: "../../etc/passwd" }))).icon).toBeUndefined();
});

test("every built-in carries its icon as an installed one would", () => {
  for (const w of BUILTIN_WIDGETS) expect(w.icon).toStartWith("data:image/svg+xml,");
});

test("its version is what its widget.json says, when it looks like one: what an update is compared by", async () => {
  expect((await readWidget(widget({ version: "1.2.0" }))).version).toBe("1.2.0");
  expect((await readWidget(widget({ version: "soon" }))).version).toBeUndefined();
  expect((await readWidget(widget({}))).version).toBeUndefined();
});

test("its category is what its widget.json says, from the list; none is other, and one not on the list is refused", async () => {
  expect((await readWidget(widget({ category: "fun" }))).category).toBe("fun");
  expect((await readWidget(widget({}))).category).toBe("other");
  await expect(readWidget(widget({ category: "games" }))).rejects.toThrow('"category" must be one of');
  for (const w of BUILTIN_WIDGETS) expect(w.category).toBe("productivity");
});

test("the commands its widget.json declares are read, in order, for an agent to run", async () => {
  const commands = [{ name: "add", description: "Add a step.", args: "{ \"text\": string }" }, { name: "list", description: "Every step." }];
  const w = await readWidget(widget({ id: "@acme/steps", category: "agents", commands }));
  expect([w.category, w.commands.map((c) => c.name)]).toEqual(["agents", ["add", "list"]]);
});

test("a tint left empty or null is no tint, and no problem; a word that is not a note colour is one", async () => {
  // A text option the person has not filled in draws its "$options.color" as "".
  const pkg = await readWidget(widget({ options: [{ id: "color", label: "Colour", type: "text", default: "" }], draw: { type: "stack", tint: "$options.color", children: [] } }));
  const drawn = widgetTree({ id: "w", widget: pkg.id }, pkg, undefined);
  expect([tintProblem(drawn), tintProblem({ type: "stack", tint: null, children: [] })]).toEqual([null, null]);
  expect(tintProblem({ ...(drawn as object), tint: "red" })).toContain('tint "red"');
});
