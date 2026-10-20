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
    expect(await plugin({ "hivemind-tool.json": JSON.stringify({ id: "ada/ports", name: "Ports", version: "1.0.0", entry: "tool.js", tools: [{ key: "ports", label: "Ports", tileKind: "ports" }], apiVersion: 1 }), "tool.js": "" }))
      .toMatchObject({ id: "ada/ports", type: "tool", version: "1.0.0" });
  });

  test("a folder Hivemind would refuse is refused with a sentence that says why", async () => {
    const cases: [Record<string, string | Uint8Array>, string | RegExp][] = [
      [{}, "the folder is empty"],
      [{ "notes.txt": "" }, "no agent.yaml, hivemind-view.json, widget.json or hivemind-tool.json in that folder"],
      [{ ...widget(), "../x": "" }, "../x is not a plain relative path"],
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
      [{ "hivemind-tool.json": JSON.stringify({ id: "ada/work--trees", name: "W", version: "1.0.0", entry: "tool.js", tools: [{ key: "w", label: "W", tileKind: "work-trees" }], apiVersion: 1 }), "tool.js": "" },
        "hivemind-tool.json: its id is not a tool id — it must be owner/name"],
    ];
    for (const [files, want] of cases) {
      const got = await problem(files);
      if (typeof want === "string") expect(got).toBe(want);
      else expect(got).toMatch(want);
    }
  });
});

test("a view's, widget's or tool's owner is the account that publishes it; an agent has none", () => {
  expect(ownerProblem("view", "@dip497/board", "Dip497")).toBeNull(); // GitHub logins are case-blind
  expect(ownerProblem("widget", "@alice/board", "dip497")).toMatch(/the scope must be @dip497/);
  expect(ownerProblem("view", "board", "dip497")).toMatch(/set it to "@dip497\/board"/);
  expect(ownerProblem("tool", "dip497/worktrees", "dip497")).toBeNull();
  expect(ownerProblem("tool", "alice/worktrees", "dip497")).toMatch(/owner must be dip497/);
  expect(ownerProblem("agent", "gemini", "anyone")).toBeNull();
});
