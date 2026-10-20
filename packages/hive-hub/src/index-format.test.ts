import { describe, expect, test } from "bun:test";
import { parseHubIndex, writeHubIndex } from "./index-format.js";

const view = { id: "@a/x", type: "view", name: "X", description: "d", author: "a", version: "1", path: "views/x", files: [{ path: "a.js", sha256: "0".repeat(64) }] };
/** What the index says about one entry: the entry it lists, or the reason it was skipped. */
const one = (entry: object) => {
  const { plugins, skipped } = parseHubIndex({ version: 1, plugins: [entry] });
  return plugins[0] ?? skipped[0]!.reason;
};

describe("reading an index", () => {
  test("an entry that could reach outside its folder or skip integrity is skipped with the reason", () => {
    const bad = (patch: object) => one({ ...view, ...patch });
    // A view carries its publisher's scope; an agent is one name, never scoped.
    expect(bad({ id: "x" })).toBe("its id is not a view id — it must be @owner/name");
    expect(bad({ id: "a/x" })).toMatch(/must be @owner\/name/);
    expect(bad({ id: "@a/x--y" })).toMatch(/must be @owner\/name/);
    expect(bad({ id: "Bad Id" })).toMatch(/view id/);
    expect(bad({ type: "agent", id: "@a/x" })).toMatch(/must be one name/);
    expect(bad({ type: "agent", id: "gemini" })).toMatchObject({ id: "gemini", type: "agent" });
    expect(bad({ path: "../etc" })).toMatch(/relative folder/);
    expect(bad({ path: "/abs" })).toMatch(/relative folder/);
    expect(bad({ files: [{ path: "../../x", sha256: "0".repeat(64) }] })).toMatch(/relative path/);
    expect(bad({ files: [{ path: "a.js" }] })).toMatch(/sha256/);
    expect(bad({ files: [{ path: "NUL.js", sha256: "0".repeat(64) }] })).toMatch(/relative path/);
    expect(bad({ bin: "x" })).toMatch(/bare name of an agent/); // views have no CLI
    expect(bad({ type: "agent", id: "x", bin: "../bin/sh" })).toMatch(/bare name/);
    expect(bad({ name: "" })).toMatch(/needs a name, description, author and version/);
  });

  test("text that could rewrite a terminal is skipped, and a skipped entry's id is named only when it is plain", () => {
    const bad = (patch: object) => one({ ...view, ...patch });
    expect(bad({ name: "X\u001b]0;owned\u0007" })).toMatch(/in plain text/);
    expect(bad({ description: "safe \u009b2J" })).toMatch(/in plain text/);
    expect(bad({ author: "\u202eevil" })).toMatch(/in plain text/);
    const read = parseHubIndex({ version: 1, plugins: [{ ...view, id: "@a/x\u001b[2J", type: "theme" }] });
    expect(read.skipped[0]).toMatchObject({ id: null });
  });

  test("files that would land on one another are skipped: named twice, in any letter case, or one inside another", () => {
    const sha = "0".repeat(64);
    expect(one({ ...view, files: [{ path: "widget.js", sha256: sha }, { path: "Widget.js", sha256: "1".repeat(64) }] })).toBe("its files: Widget.js is listed twice");
    expect(one({ ...view, files: [{ path: "a", sha256: sha }, { path: "a/b.js", sha256: sha }] })).toBe("its files: a/b.js is inside a, which is a file");
  });

  test("an entry nested too deep to read costs only itself", () => {
    let icon: unknown = [];
    for (let i = 0; i < 200_000; i++) icon = [icon];
    const read = parseHubIndex({ version: 1, plugins: [{ ...view, type: "agent", id: "deep", icon }, view] });
    expect(read.plugins.map((e) => e.id)).toEqual(["@a/x"]);
    expect(read.skipped).toEqual([{ position: 0, id: "deep", reason: "its icon must be a small object" }]);
  });

  test("a document that is not a version 1 index is refused whole", () => {
    expect(() => parseHubIndex({ version: 2, plugins: [] })).toThrow(/version 1/);
    expect(() => parseHubIndex({ version: 1 })).toThrow(/version 1/);
  });

  test("the bad entry is named by its place and id, and every other entry is still listed", () => {
    const read = parseHubIndex({ version: 1, plugins: [view, { ...view, id: "@a/y", files: [] }, null, { ...view, id: "@a/z" }] });
    expect(read.plugins.map((e) => e.id)).toEqual(["@a/x", "@a/z"]);
    expect(read.skipped).toEqual([
      { position: 1, id: "@a/y", reason: "its files must list 1-200 files" },
      { position: 2, id: null, reason: "its type, null, is not a kind this Hivemind knows" },
    ]);
  });

  test("a plugin listed twice keeps its first entry", () => {
    const read = parseHubIndex({ version: 1, plugins: [view, { ...view, version: "2" }] });
    expect(read.plugins.map((e) => e.version)).toEqual(["1"]);
    expect(read.skipped).toEqual([{ position: 1, id: "@a/x", reason: "view:@a/x is listed earlier in the index" }]);
  });

  test("a widget is scoped like a view, and a kind this app does not know is skipped, not the catalog", () => {
    const widget = { ...view, id: "@a/pet", type: "widget", path: "widgets/pet" };
    const read = parseHubIndex({ version: 1, plugins: [view, widget, { ...view, id: "@a/later", type: "theme" }] });
    expect(read.plugins.map((e) => `${e.type}:${e.id}`)).toEqual(["view:@a/x", "widget:@a/pet"]);
    expect(read.skipped).toEqual([{ position: 2, id: "@a/later", reason: 'its type, "theme", is not a kind this Hivemind knows' }]);
    expect(one({ ...widget, id: "pet" })).toBe("its id is not a widget id — it must be @owner/name");
  });

  test("a tool is listed under its @owner/name, and its folder name rules out --", () => {
    const tool = { ...view, id: "@dip497/worktrees", type: "tool", path: "tools/worktrees" };
    expect(one(tool)).toMatchObject({ type: "tool", id: "@dip497/worktrees" });
    expect(one({ ...tool, id: "dip497/worktrees" })).toBe("its id is not a tool id — it must be @owner/name");
    // Its folder on disk is owner--name, so a `--` in the id could stand for two tools.
    expect(one({ ...tool, id: "@dip497/work--trees" })).toMatch(/a tool id/);
  });

  test("a package is listed under its @owner/name with what it holds; only a package has members", () => {
    const members = [{ kind: "view", id: "@ada/island", name: "Island", permissions: ["workspace:issues"] }, { kind: "tool", id: "@ada/prs", name: "PRs", permissions: [] }];
    const pkg = { ...view, id: "@ada/kit", type: "package", path: "kit", members };
    expect(one(pkg)).toMatchObject({ type: "package", id: "@ada/kit", members });
    expect(one({ ...pkg, members: [] })).toBe("its members must list 1-64 members of a package");
    expect(one({ ...pkg, members: [{ kind: "view", id: "island", name: "Island", permissions: [] }] })).toBe("members[0] needs a kind, an @owner/name id, a name and its permissions");
    expect(one({ ...view, members })).toBe("its members must list 1-64 members of a package");
  });

  test("each entry has the category its manifest gave it: other when it gave none the app knows, agents for an agent", () => {
    const { plugins } = parseHubIndex({ version: 1, plugins: [
      { ...view, id: "@a/git-graph", category: "git" },
      { ...view, id: "@a/pet", type: "widget", category: "fun" },
      { ...view, id: "@dip497/ports", type: "tool", category: "monitoring" },
      { ...view, id: "@a/none", type: "widget" },
      { ...view, id: "@a/odd", type: "widget", category: "games" },
      { ...view, id: "gemini", type: "agent" },
    ] });
    expect(plugins.map((e) => [e.id, e.category])).toEqual([
      ["@a/git-graph", "git"], ["@a/pet", "fun"], ["@dip497/ports", "monitoring"], ["@a/none", "other"], ["@a/odd", "other"], ["gemini", "agents"],
    ]);
  });

  test("a plugin may live in its own repository, and a source that is not an https base is skipped", () => {
    const far = { ...view, source: "https://example.test/repo/" };
    expect(one(far)).toMatchObject({ source: "https://example.test/repo/" });
    for (const bad of ["http://example.test/", "https://example.test/../etc", "file:///etc", 7]) {
      expect(one({ ...far, source: bad })).toBe("its source must be an https base URL");
    }
    // Absent is the normal case: the files sit beside the index.
    expect(one({ ...far, source: undefined })).not.toHaveProperty("source");
  });

  test("a plugin can name the oldest Hivemind it runs on", () => {
    expect(one({ ...view, minAppVersion: "2.4.0" })).toMatchObject({ minAppVersion: "2.4.0" });
    expect(one({ ...view, minAppVersion: "next" })).toMatch(/minAppVersion/);
  });

  test("an agent may carry its own mark, bounded but not understood here", () => {
    const agent = { ...view, id: "acme", type: "agent" };
    const icon = { viewBox: "0 0 16 16", shapes: [{ rect: { x: "2", y: "2", width: "12", height: "12" } }] };
    // Carried through as written: what an icon may contain is decided where it is drawn.
    expect(one({ ...agent, icon })).toMatchObject({ icon });
    expect(one(agent)).not.toHaveProperty("icon");
    for (const bad of ["<svg/>", 7, { shapes: Array.from({ length: 400 }, () => ({ rect: { x: "1" } })) }]) {
      expect(one({ ...agent, icon: bad })).toBe("its icon must be a small object");
    }
  });

});

test("a hub writes only the entries the app reads, and names the rest", () => {
  const { index, skipped } = writeHubIndex([view, { ...view, id: "a/old", type: "tool" }]);
  expect(index.plugins.map((e) => e.id)).toEqual(["@a/x"]);
  expect(skipped).toEqual([{ position: 1, id: "a/old", reason: "its id is not a tool id — it must be @owner/name" }]);
  expect(parseHubIndex(JSON.parse(JSON.stringify(index))).skipped).toEqual([]);
});
