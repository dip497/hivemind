import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { checkPluginFolder, checkPluginListing, firstReads, listedFile, MAX_PLUGIN_FILE_BYTES, ownerProblem, planRead } from "./plugin-checks.js";
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

describe("a folder read a few files at a time", () => {
  const pkg = (extra: object = {}) => JSON.stringify({ apiVersion: 2, id: "@ada/kit", name: "Kit", version: "1.0.0", widgets: [{ path: "pet" }], views: [{ path: "graph/dist" }], ...extra });
  const kit = (over: Record<string, string | Uint8Array> = {}) => ({
    "hivemind-package.json": pkg(), "README.md": "# Kit", "LICENSE": "MIT",
    "pet/widget.json": JSON.stringify({ id: "@ada/pet", name: "Pet", version: "1.0.0", icon: "pet.svg" }), "pet/widget.js": "", "pet/pet.svg": "<svg/>", "pet/README.md": "# Pet",
    "graph/dist/hivemind-view.json": JSON.stringify({ id: "@ada/graph", entry: "index.html" }), "graph/dist/index.html": "<p>",
    // What the view is built from, beside what installs.
    "graph/src/main.ts": "", "graph/hivemind-view.json": "{", "scripts/build.mjs": "", ...over,
  });
  const sizedOf = (files: Record<string, string | Uint8Array>) => folder(files).map((f) => ({ path: f.path, bytes: f.bytes.byteLength }));
  /** What a hub makes of a folder reading only what the plan names: the top's texts first, then the
   *  rest, keeping only the texts the plan names. */
  const readByPlan = async (files: Record<string, string | Uint8Array>) => {
    const all = folder(files);
    const first = firstReads(sizedOf(files));
    if ("problem" in first) return { plan: first, check: null };
    const texts = Object.fromEntries(await Promise.all(all.filter((f) => first.read.includes(f.path)).map(async (f) => [f.path, (await listedFile(f.path, f.bytes, true)).text!])));
    const plan = planRead(sizedOf(files), texts);
    if ("problem" in plan) return { plan, check: null };
    const listing = await Promise.all(all.filter((f) => plan.read.includes(f.path)).map((f) => listedFile(f.path, f.bytes, plan.text.includes(f.path))));
    return { plan, check: await checkPluginListing(listing) };
  };
  const view = { "hivemind-view.json": JSON.stringify({ id: "@ada/graph", entry: "index.html", icon: "icon.svg" }), "index.html": "<p>", "icon.svg": "<svg/>", "README.md": "# Graph" };
  // A widget whose marks and notes are not its icon or its README.
  const marked = { ...widget({ icon: "icon.svg" }), "icon.svg": "<svg/>", "README.md": "# Pet", "docs/README.md": "# More",
    ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`marks/m${i}.svg`, `<svg>${" ".repeat(4000)}</svg>`])) };

  test("reading only what the plan names gives the check's own answer, keeping only the texts it reads", async () => {
    for (const files of [kit(), widget(), view, marked, { ...kit(), "pet/widget.json": "{" }, { ...widget(), "big.bin": new Uint8Array((2 << 20) + 1) }]) {
      const { plan, check } = await readByPlan(files);
      expect(check ?? plan).toEqual(await checkPluginFolder(folder(files)));
    }
    expect((await readByPlan(kit())).plan).toEqual({
      read: ["hivemind-package.json", "README.md", "LICENSE", "pet/widget.json", "pet/widget.js", "pet/pet.svg", "pet/README.md", "graph/dist/hivemind-view.json", "graph/dist/index.html"],
      text: ["hivemind-package.json", "README.md", "pet/widget.json", "graph/dist/hivemind-view.json"],
    });
    expect((await readByPlan(marked)).plan).toMatchObject({ text: ["widget.json", "README.md", "icon.svg"] });
  });

  test("a package's manifest is read first, and what it leaves out is not read", async () => {
    const files = kit(Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`graph/src/f${i}.ts`, ""])));
    expect(firstReads(sizedOf(files))).toEqual({ read: ["hivemind-package.json", "README.md"] });
    expect(planRead(sizedOf(files), { "hivemind-package.json": "{" })).toEqual({ problem: "hivemind-package.json is not valid JSON" });
    // 300 sources beside it, 9 files that install: the hub reads the 9, and takes them.
    const { plan, check } = await readByPlan(files);
    expect("read" in plan && plan.read.length).toBe(9);
    expect(check).toMatchObject({ plugin: { id: "@ada/kit" } });
    // The app's check of what it was given holds all of it to the limits, as it always has.
    expect(await problem(files)).toBe("a plugin may have at most 200 files");
    // What installs is held to the limits.
    const many = kit(Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`pet/f${i}.svg`, ""])));
    expect(planRead(sizedOf(many), { "hivemind-package.json": pkg() })).toEqual({ problem: "a plugin may have at most 200 files" });
  });

  test("a folder the paths alone refuse is refused before anything is read", () => {
    const sized = (paths: string[]) => paths.map((path) => ({ path, bytes: 1 }));
    expect(firstReads([])).toEqual({ problem: "the folder is empty" });
    expect(firstReads(sized(["index.js", "notes.txt"]))).toEqual({ problem: "no hivemind-package.json, agent.yaml, hivemind-view.json, widget.json or hivemind-tool.json in that folder" });
    expect(firstReads(sized(["widget.json", "Widget.json"]))).toEqual({ problem: "Widget.json is listed twice" });
    expect(firstReads([{ path: "widget.json", bytes: 1 }, { path: "a.bin", bytes: (2 << 20) + 1 }])).toEqual({ problem: "a.bin is larger than 2 MB" });
    // A package manifest too large to read is named, not missed.
    expect(firstReads([{ path: "hivemind-package.json", bytes: 300 << 10 }, { path: "pet/widget.json", bytes: 1 }])).toEqual({ problem: "hivemind-package.json is larger than 256 KB" });
  });

  test("a listing without a hash or a text the plan names is refused, never read as missing", async () => {
    const files = { ...widget({ icon: "pet.svg" }), "pet.svg": "<svg/>", "mark.svg": "<svg/>" };
    const keep = ["widget.json", "pet.svg"];
    const listing = await Promise.all(folder(files).map((f) => listedFile(f.path, f.bytes, keep.includes(f.path))));
    // A mark that is not its icon needs no text.
    expect("plugin" in (await checkPluginListing(listing))).toBe(true);
    const without = (path: string, key: "text" | "sha256") => listing.map((f) => (f.path === path ? { ...f, [key]: undefined } : f)) as typeof listing;
    expect(await checkPluginListing(without("pet.svg", "text"))).toEqual({ problem: '"pet.svg" was listed without its text' });
    expect(await checkPluginListing(without("widget.json", "text"))).toEqual({ problem: '"widget.json" was listed without its text' });
    expect(await checkPluginListing(without("widget.js", "sha256"))).toEqual({ problem: '"widget.js" was listed without its SHA-256' });
    // A README is kept as far as the listing shows it, so a hub carries no more of it.
    expect((await listedFile("README.md", new TextEncoder().encode("x".repeat(100 << 10)), true)).text).toHaveLength(64 << 10);
  });

  test("a view's icon is listed as a widget's is: a small SVG kept, a picture linked, a large one not shown", async () => {
    const view = (icon: string, body: string | Uint8Array) => plugin({ "hivemind-view.json": JSON.stringify({ id: "@ada/graph", entry: "index.html", icon }), "index.html": "<p>", [icon]: body });
    expect(await view("icon.svg", "<svg/>")).toMatchObject({ icon: { image: `data:image/svg+xml;base64,${btoa("<svg/>")}` }, iconFile: null });
    expect(await view("icon.png", new Uint8Array(8))).toMatchObject({ icon: null, iconFile: "icon.png" });
    expect(await view("icon.svg", `<svg>${" ".repeat(16 << 10)}</svg>`)).toMatchObject({ icon: null, iconFile: null });
    // Under 16 KB on disk, but not UTF-8: written out it is three times the size, so it is not shown.
    const latin1 = new Uint8Array([...new TextEncoder().encode("<svg><desc>"), ...new Uint8Array(15_000).fill(0xe9), ...new TextEncoder().encode("</desc></svg>")]);
    expect(await view("icon.svg", latin1)).toMatchObject({ icon: null, iconFile: null });
  });

  test("whatever the app is handed, the check answers with a reason, never a crash", async () => {
    expect(await checkPluginFolder([{ path: undefined as never, bytes: new Uint8Array() }])).toHaveProperty("problem");
    expect(await checkPluginFolder([{ path: "widget.json", bytes: null as never }])).toHaveProperty("problem");
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
