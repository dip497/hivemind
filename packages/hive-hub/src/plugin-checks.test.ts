import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { checkPluginFolder, ownerProblem } from "./plugin-checks.js";
import { parseHubIndex } from "./index-format.js";

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

  test("a package is refused for its manifest, a member its kind refuses, or a member of another owner", async () => {
    expect(await problem({ "hivemind-package.json": manifest({ apiVersion: 1 }), ...pet() })).toMatch(/^hivemind-package\.json: apiVersion/);
    expect(await problem({ "hivemind-package.json": manifest(), "pet/widget.json": JSON.stringify({ id: "@ada/pet", version: "1.0.0" }) }))
      .toBe("pet: a widget needs a widget.js, or a draw in its widget.json");
    expect(await problem({ "hivemind-package.json": manifest(), "pet/notes.txt": "" })).toBe("pet: widgets names a folder holding no widget.json");
    expect(await problem({ "hivemind-package.json": manifest(), ...pet("@bob/pet") })).toBe("widget @bob/pet is not @ada's: every member of @ada/kit is @ada/<name>");
    // A member's folder inside another's would be listed as one kind and installed as part of the other.
    const tool = { "pet/inner/hivemind-tool.json": JSON.stringify({ apiVersion: 1, id: "@ada/inner", name: "Inner", version: "1.0.0", entry: "tool.js", tools: [{ key: "i", label: "I", tileKind: "inner" }] }), "pet/inner/tool.js": "" };
    expect(await problem({ "hivemind-package.json": manifest({ tools: [{ path: "pet/inner" }] }), ...pet(), ...tool })).toBe("pet/inner is inside pet, another member's folder");
    expect(await problem({ "hivemind-package.json": manifest({ tools: [{ path: "pet" }] }), ...pet() })).toBe("two members share a folder");
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
