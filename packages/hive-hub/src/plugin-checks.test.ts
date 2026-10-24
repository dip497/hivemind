import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { checkPluginFolder, MAX_PLUGIN_FILE_BYTES, ownerProblem } from "./plugin-checks.js";
import { THEME_FILE_LIMITS } from "@hivemind/core/theme-format";
import { parseHubIndex, writeHubIndex } from "./index-format.js";
import { laterOf, SINCE, sinceOf } from "./since.js";

const folder = (files: Record<string, string | Uint8Array>) =>
  Object.entries(files).map(([path, body]) => ({ path, bytes: typeof body === "string" ? new TextEncoder().encode(body) : body }));
const problem = async (files: Record<string, string | Uint8Array>) => {
  const r = await checkPluginFolder(folder(files));
  return "problem" in r ? r.problem : null;
};
const plugin = async (files: Record<string, string | Uint8Array>) => {
  const r = await checkPluginFolder(folder(files));
  if ("problem" in r) throw new Error(r.problem);
  return r.plugin;
};

const AGENT = "manifestVersion: 2\nid: gemini\nlabel: Gemini\nbin: gemini\nenabled: true\n"
  + "caps:\n  promptDelivery: typed\n  turnSignal: false\n  resume: none\n  supervise: human\n  blockedDetection: false\n";
const widget = (extra: object = {}) => ({
  "widget.json": JSON.stringify({ id: "@ada/pet", name: "Pet", version: "1.0.0", ...extra }),
  "widget.js": "export default {}",
});

describe("checking a plugin folder", () => {
  test("each kind is read from its manifest, with a hash per file that the index reader accepts", async () => {
    const files = { ...widget({ category: "fun" }), "README.md": "# Pet" };
    const pet = await plugin(files);
    expect(pet).toMatchObject({ id: "@ada/pet", type: "widget", version: "1.0.0", category: "fun", readme: "# Pet" });
    expect(pet.files).toEqual(Object.entries(files).map(([path, body]) => ({ path, sha256: createHash("sha256").update(body).digest("hex") }))
      .sort((a, b) => a.path.localeCompare(b.path)));
    // What a hub lists from the check is an entry the app reads.
    const { id, type, name, description, version, category } = pet;
    const listed = parseHubIndex({ version: 1, plugins: [{ id, type, name, description, version, category, files: pet.files, author: "ada", path: "widgets/pet" }] });
    expect(listed.skipped).toEqual([]);

    expect(await plugin({ "agent.yaml": AGENT })).toMatchObject({ id: "gemini", type: "agent", bin: "gemini", category: "agents", description: "Runs gemini." });
    expect(await plugin({ "hivemind-view.json": JSON.stringify({ id: "@ada/graph", entry: "index.html", category: "git" }), "index.html": "<p>" }))
      .toMatchObject({ id: "@ada/graph", type: "view", category: "git" });
    expect(await plugin({ "hivemind-tool.json": JSON.stringify({ id: "@ada/ports", name: "Ports", version: "1.0.0", entry: "tool.js", tools: [{ key: "ports", label: "Ports", tileKind: "ports" }], apiVersion: 1 }), "tool.js": "" }))
      .toMatchObject({ id: "@ada/ports", type: "tool", version: "1.0.0" });
  });

  test("a folder Hivemind would refuse is refused with a sentence that says why", async () => {
    const cases: [Record<string, string | Uint8Array>, string | RegExp][] = [
      [{}, "the folder is empty"],
      [{ "notes.txt": "" }, "no hivemind-package.json, agent.yaml, hivemind-view.json, widget.json or hivemind-tool.json in that folder"],
      [{ ...widget(), "../x": "" }, "\"../x\" is not a plain relative path"],
      [{ ...widget(), "big.bin": new Uint8Array((2 << 20) + 1) }, "big.bin is larger than 2 MB"],
      [{ ...widget(), ...Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`f${i}.bin`, new Uint8Array(2 << 20)])) }, "a plugin folder may be at most 8 MB"],
      [Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`f${i}.js`, ""])), "a plugin may have at most 200 files"],
      [widget({ id: "pet" }), /a published widget says its id, @owner\/name/],
      [widget({ version: undefined }), 'widget.json needs a "version", like "1.0.0"'],
      [{ "widget.json": JSON.stringify({ id: "@ada/pet", version: "1.0.0" }) }, "a widget needs a widget.js, or a draw in its widget.json"],
      [widget({ category: "games" }), /widget\.json: "category" must be one of code, git, agents/],
      [{ "hivemind-view.json": JSON.stringify({ id: "@ada/graph", entry: "missing.html" }) }, "hivemind-view.json names an entry file that is not in the folder"],
      [{ "hivemind-view.json": "{" }, "hivemind-view.json is not valid JSON"],
      [{ "agent.yaml": AGENT.replace("id: gemini", "id: claude") }, /"claude" is Hivemind's agent for `claude`, but this manifest launches `gemini`/],
      [{ "agent.yaml": AGENT.replace("id: gemini", "id: gem--ini") }, `agent.yaml's id is "gem--ini" — an agent's id is one name, like "gemini"`],
      [{ "agent.yaml": "id: x\n" }, /the manifest is not one Hivemind would accept/],
      [{ "hivemind-tool.json": JSON.stringify({ id: "@ada/work--trees", name: "W", version: "1.0.0", entry: "tool.js", tools: [{ key: "w", label: "W", tileKind: "work-trees" }], apiVersion: 1 }), "tool.js": "" },
        "hivemind-tool.json: its id is not a tool id — it must be @owner/name"],
    ];
    for (const [files, want] of cases) {
      const got = await problem(files);
      if (typeof want === "string") expect(got).toBe(want);
      else expect(got).toMatch(want);
    }
  });
});

describe("what a folder holds is never printed as it is", () => {
  test("a name or description that could rewrite a terminal is refused, and a quoted value is escaped", async () => {
    expect(await problem(widget({ name: "Pet\u001b[2J" }))).toBe("widget.json: its name has a control character in it");
    expect(await problem(widget({ description: "\u202eevil" }))).toBe("widget.json: its description has a control character in it");
    expect(await problem({ "widget.json": JSON.stringify({ id: "\u001b]0;x\u0007", version: "1.0.0" }), "widget.js": "" }))
      .toBe("widget.json's id is \"\\u001b]0;x\\u0007\" — a published widget says its id, @owner/name, in its widget.json");
  });

  test("an agent's whole note and what its manifest makes it do are plain text", async () => {
    const long = "x".repeat(500);
    expect(await problem({ "agent.yaml": `${AGENT}note: "${long}\\u001b[2J"\n` })).toBe("agent.yaml: its note has a control character in it");
    expect((await plugin({ "agent.yaml": `${AGENT}note: "${long}"\n` })).note).toBe(long);
    const listed = (arg: string) => `${AGENT}options:\n- id: model\n  label: Model\n  flag: --model\n  list:\n    args: ["${arg}"]\n`;
    expect((await plugin({ "agent.yaml": listed("models") })).does).toContain("runs `gemini models` to list model values");
    // The manifest's own refusal quotes the value, escaped.
    expect(await problem({ "agent.yaml": listed("models\\u001b[2J") })).toBe('the manifest is not one Hivemind would accept — options[0].list.args: "models\\u001b[2J" is not a plain token');
    const labelled = `${AGENT}options:\n- id: model\n  label: "Mo\\u009bdel"\n  flag: --model\n  list:\n    args: [models]\n`;
    expect(await problem({ "agent.yaml": labelled })).toBe("agent.yaml: its launch settings has a control character in it");
  });

  test("a package member's folder with a control character is refused by the manifest check", async () => {
    expect(await problem({ "hivemind-package.json": JSON.stringify({ apiVersion: 2, id: "@ada/kit", name: "Kit", version: "1.0.0", widgets: [{ path: "p\u009bet" }] }) }))
      .toMatch(/^hivemind-package\.json: widgets\.0\.path: expected a relative path inside the package/);
  });

  test("two files that would land on one another are refused", async () => {
    expect(await problem({ ...widget(), "Widget.js": "x" })).toBe("Widget.js is listed twice");
    expect(await problem({ ...widget(), "a": "", "a/b.js": "" })).toBe("a/b.js is inside a, which is a file");
  });
});

describe("checking a package", () => {
  const manifest = (extra: object = {}) => JSON.stringify({ apiVersion: 2, id: "@ada/kit", name: "Kit", version: "1.0.0",
    widgets: [{ path: "pet" }], agents: [{ id: "@ada/reviewer", name: "Reviewer", provider: "claude", prompt: "Review." }], ...extra });
  const pet = (id = "@ada/pet") => ({ "pet/widget.json": JSON.stringify({ id, name: "Pet", version: "1.0.0", permissions: ["workspace:issues"] }), "pet/widget.js": "" });

  test("each member is read as its kind is read alone, and listed with where it runs and what it asks", async () => {
    const kit = await plugin({ "hivemind-package.json": manifest(), ...pet() });
    expect(kit).toMatchObject({ id: "@ada/kit", type: "package", version: "1.0.0", description: "A package of 2: Pet, Reviewer." });
    expect(kit.members).toEqual([
      { kind: "widget", id: "@ada/pet", name: "Pet", runs: "sandboxed", permissions: ["workspace:issues"], does: expect.arrayContaining(["Runs in a sandbox that holds it to what it asks for"]) },
      { kind: "agent-preset", id: "@ada/reviewer", name: "Reviewer", runs: "as an agent's instructions", permissions: [],
        does: ["Instructions an agent follows: starts claude with the prompt in hivemind-package.json"] },
    ]);
    const { id, type, name, description, version, category, members } = kit;
    const listed = parseHubIndex({ version: 1, plugins: [{ id, type, name, description, version, category, files: kit.files, author: "ada", path: "kit",
      members: members!.map(({ kind, id, name, permissions }) => ({ kind, id, name, permissions })) }] });
    expect(listed.skipped).toEqual([]);
  });

  test("a package lists its own manifest, README and licence and its members' files, and nothing else beside them", async () => {
    const kit = await plugin({ "hivemind-package.json": manifest(), ...pet(), "README.md": "# Kit", "LICENSE": "MIT",
      "src/build.ts": "", "notes.txt": "", "pet-old/widget.js": "" });
    expect(kit.files.map((f) => f.path)).toEqual(["hivemind-package.json", "LICENSE", "pet/widget.js", "pet/widget.json", "README.md"]);
  });

  test("a package is refused for its manifest, a member its kind refuses, or a member of another owner", async () => {
    expect(await problem({ "hivemind-package.json": manifest({ apiVersion: 1 }), ...pet() })).toMatch(/^hivemind-package\.json: apiVersion/);
    expect(await problem({ "hivemind-package.json": manifest(), "pet/widget.json": JSON.stringify({ id: "@ada/pet", version: "1.0.0" }) }))
      .toBe('"pet": a widget needs a widget.js, or a draw in its widget.json');
    expect(await problem({ "hivemind-package.json": manifest(), "pet/notes.txt": "" })).toBe('"pet": widgets names a folder holding no widget.json');
    expect(await problem({ "hivemind-package.json": manifest(), ...pet("@bob/pet") })).toBe("widget @bob/pet is not @ada's: every member of @ada/kit is @ada/<name>");
    // A member's folder inside another's would be listed as one kind and installed as part of the other.
    const tool = { "pet/inner/hivemind-tool.json": JSON.stringify({ apiVersion: 1, id: "@ada/inner", name: "Inner", version: "1.0.0", entry: "tool.js", tools: [{ key: "i", label: "I", tileKind: "inner" }] }), "pet/inner/tool.js": "" };
    expect(await problem({ "hivemind-package.json": manifest({ tools: [{ path: "pet/inner" }] }), ...pet(), ...tool })).toBe('"pet/inner" is inside "pet", another member\'s folder');
  });

  const THEME = { format: 1, name: "Harbour", mode: "dark", accent: "ice", wallpaper: { image: "still.webp" },
    palette: { bg: "#0e1a24", bg2: "#14242f", bg3: "#1b2e3b", bg4: "#233847", line: "#233847", line2: "#2f4757", fg: "#eef3f6", fg2: "#c3cfd6", fg3: "#8fa0ab", select: "#c3cfd6", ok: "#7fc49a", warn: "#e6b866", err: "#e08a7a" } };
  const harbour = (theme: object = THEME) => ({ "themes/harbour/theme.json": JSON.stringify(theme), "themes/harbour/still.webp": new Uint8Array(64) });

  test("a theme is listed as data: its id in the package, its name, and that it changes how the app looks", async () => {
    const kit = await plugin({ "hivemind-package.json": manifest({ themes: [{ path: "themes/harbour" }] }), ...pet(), ...harbour() });
    expect(kit.members).toContainEqual({ kind: "theme", id: "@ada/kit/harbour", name: "Harbour", runs: "nothing: it is data", permissions: [],
      does: ["Changes how the app looks and sounds, once you apply it (1 file: fonts, a wallpaper or sounds)"] });
    expect(kit.does).toContain("Changes how the app looks and sounds, once you apply it (1 file: fonts, a wallpaper or sounds)");
    // What a hub lists from the check is an entry the app reads: a theme's three-part id too.
    const { id, type, name, description, version, category, members } = kit;
    const { index, skipped } = writeHubIndex([{ id, type, name, description, version, category, members, files: kit.files, author: "ada", path: "packages/kit" }]);
    expect(skipped).toEqual([]);
    expect(parseHubIndex(JSON.parse(JSON.stringify(index))).plugins[0]?.members).toContainEqual(expect.objectContaining({ kind: "theme", id: "@ada/kit/harbour" }));
  });

  test("a theme's files as large as the app takes are files the hub takes", async () => {
    const pkg = manifest({ themes: [{ path: "themes/harbour" }] });
    const at = (bytes: number) => problem({ "hivemind-package.json": pkg, ...pet(), ...harbour(), "themes/harbour/still.webp": new Uint8Array(bytes) });
    expect(await at(THEME_FILE_LIMITS.image)).toBeNull();
    expect(await at(THEME_FILE_LIMITS.image + 1)).toMatch(/still\.webp is larger than 2 MB/);
    expect(THEME_FILE_LIMITS.video).toBeLessThanOrEqual(MAX_PLUGIN_FILE_BYTES);
  });

  test("a theme the app would refuse is refused by the hub for the same reason", async () => {
    const pkg = manifest({ themes: [{ path: "themes/harbour" }] });
    expect(await problem({ "hivemind-package.json": pkg, ...pet(), ...harbour({ ...THEME, palette: { ...THEME.palette, fg: "#3a4652" } }) }))
      .toMatch(/^"themes\/harbour": theme\.json: palette: fg on bg is .*:1; it needs at least 4\.5:1/);
    expect(await problem({ "hivemind-package.json": pkg, ...pet(), "themes/harbour/theme.json": JSON.stringify(THEME) }))
      .toBe('"themes/harbour": theme.json: wallpaper.image: there is no still.webp in the theme\'s folder');
    expect(await problem({ "hivemind-package.json": pkg, ...pet(), "themes/harbour/notes.txt": "" })).toBe('"themes/harbour": themes names a folder holding no theme.json');
    // Sized as the app sizes it: a sound past 400 KB.
    expect(await problem({ "hivemind-package.json": pkg, ...pet(), ...harbour({ ...THEME, sounds: { done: "bell.ogg" } }), "themes/harbour/bell.ogg": new Uint8Array(500 * 1024) }))
      .toMatch(/sounds\.done: bell\.ogg is 500 KB; .* at most 400 KB/);
  });
});

describe("the oldest Hivemind a plugin needs", () => {
  const view = (extra: object = {}) => ({ "hivemind-view.json": JSON.stringify({ id: "@ada/graph", entry: "index.html", ...extra }), "index.html": "<p>" });

  test("a view or package lists the release that first accepts a field it uses; old-style ones list none", async () => {
    expect((await plugin(view({ widgets: "left" }))).minAppVersion).toBe(SINCE["view.widgets"]);
    expect((await plugin(view({ tokens: { accent: "#f80" } }))).minAppVersion).toBe(SINCE["view.tokens"]);
    // A view that fetches its own files says so, and an app before it would refuse the field.
    expect((await plugin(view({ files: true }))).minAppVersion).toBe(SINCE["view.files"]);
    expect((await plugin(view({ permissions: ["workspace:read"] }))).minAppVersion).toBeNull();
    expect((await plugin(widget())).minAppVersion).toBeNull();
    const kit = (members: object, files: Record<string, string>) => plugin({
      "hivemind-package.json": JSON.stringify({ apiVersion: 2, id: "@ada/kit", name: "Kit", version: "1.0.0", ...members }), ...files });
    const graph = Object.fromEntries(Object.entries(view({ widgets: "right" })).map(([f, b]) => [`graph/${f}`, b]));
    // A package needs what its members need.
    expect((await kit({ views: [{ path: "graph" }] }, graph)).minAppVersion).toBe(SINCE["view.widgets"]);
    const pet = Object.fromEntries(Object.entries(widget()).map(([f, b]) => [`pet/${f}`, b]));
    expect((await kit({ widgets: [{ path: "pet" }] }, pet)).minAppVersion).toBeNull();
  });

  test("a package's own field counts even when it is empty, since an app that does not know it refuses its name", () => {
    expect(sinceOf("package", { themes: [{ path: "themes/harbour" }] })).toBe(SINCE["package.themes"]);
    expect(sinceOf("package", { themes: [] })).toBe(SINCE["package.themes"]);
    expect(sinceOf("package", { widgets: [], views: [] })).toBeNull();
    expect(sinceOf("view", { themes: [] })).toBeNull();
  });

  test("the highest version wins, compared as numbers", () => {
    expect(laterOf("2026.9.10", "2026.10.1")).toBe("2026.10.1");
    expect(laterOf("2026.10.10", "2026.10.9")).toBe("2026.10.10");
    expect(laterOf(null, "2026.10.6")).toBe("2026.10.6");
    expect(laterOf("2026.10.6", null)).toBe("2026.10.6");
  });
});

test("a view's, widget's, tool's or package's owner is the account that publishes it; an agent has none", () => {
  expect(ownerProblem("view", "@dip497/board", "Dip497")).toBeNull(); // GitHub logins are case-blind
  expect(ownerProblem("widget", "@alice/board", "dip497")).toMatch(/the scope must be @dip497/);
  expect(ownerProblem("view", "board", "dip497")).toMatch(/set it to "@dip497\/board"/);
  expect(ownerProblem("tool", "@dip497/worktrees", "dip497")).toBeNull();
  expect(ownerProblem("package", "@alice/kit", "dip497")).toMatch(/the scope must be @dip497/);
  expect(ownerProblem("agent", "gemini", "anyone")).toBeNull();
});
