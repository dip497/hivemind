// The slash commands an agent takes, as its manifest says where they are: its own, the person's
// and the project's, read from real folders.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { commandsOf } from "../src/commands.js";
import { agentDisclosures, defFromManifest } from "../src/manifest.js";

const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });
const dir = () => { const d = mkdtempSync(join(tmpdir(), "hm-commands-")); made.push(d); return d; };
const put = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };

const agent = (commands: unknown) => defFromManifest({
  manifestVersion: 2, id: "acme", label: "Acme", bin: "acme", caps: { promptDelivery: "argv", turnSignal: false, resume: "none", supervise: "none", blockedDetection: false }, commands,
});

test("its own, the person's, their skills and the project's, each said as it says itself; the project's shadows the person's of a name", async () => {
  const home = dir();
  const folder = dir();
  put(join(home, ".acme/commands/review.md"), "---\ndescription: \"Review the diff\"\n---\nLook at the diff.\n");
  put(join(home, ".acme/commands/frontend/component.md"), "# Component\n\nMake a component\n");
  put(join(home, ".acme/commands/notes.txt"), "not a command");
  put(join(home, ".acme/skills/deploy/SKILL.md"), "---\nname: ship-it\ndescription: Ship to production\n---\n");
  put(join(home, ".acme/skills/inner/SKILL.md"), "---\nname: inner\nuser-invocable: false\n---\n");
  put(join(folder, ".acme/commands/review.md"), "Review as this project does\n");
  put(join(home, ".acme/prompts/fix.md"), "Fix it\n");
  const def = agent({
    builtIn: [{ name: "clear", description: "Start over" }, { name: "review" }],
    folders: [
      { path: "{home}/.acme/commands" },
      { path: "{home}/.acme/skills", skills: true },
      { path: "{home}/.acme/prompts", prefix: "prompts:" },
      { path: "{folder}/.acme/commands" },
    ],
  });
  expect(await commandsOf(def, { home, folder })).toEqual([
    { name: "clear", description: "Start over", from: "built-in" },
    { name: "frontend:component", description: "Make a component", from: "yours" },
    { name: "prompts:fix", description: "Fix it", from: "yours" },
    { name: "review", description: "Review as this project does", from: "project" },
    { name: "ship-it", description: "Ship to production", from: "yours" },
  ]);
  // Run on another machine: its folders are there, not here; only its own.
  expect(await commandsOf(def, null)).toEqual([{ name: "clear", description: "Start over", from: "built-in" }, { name: "review", from: "built-in" }]);
  expect(agentDisclosures(def)).toContain("reads the names and descriptions of your commands in {home}/.acme/commands, {home}/.acme/skills, {home}/.acme/prompts, {folder}/.acme/commands");
});

test("a folder that is not there lists nothing, and an agent that says no commands has none", async () => {
  expect(await commandsOf(agent({ folders: [{ path: "{home}/.acme/commands" }] }), { home: dir(), folder: dir() })).toEqual([]);
  expect(await commandsOf(agent(undefined), { home: dir(), folder: dir() })).toEqual([]);
});

test("a manifest names only folders under the person's home or the project, and commands by a name typed after /", () => {
  for (const path of ["/etc", "~/.acme", "{home}/../etc", "{folder}/../../x", "relative/commands"]) {
    expect(() => agent({ folders: [{ path }] })).toThrow(/under \{home\}\/ or \{folder\}\//);
  }
  expect(() => agent({ builtIn: [{ name: "/clear" }] })).toThrow(/command's name/);
  expect(() => agent({ builtIn: [{ name: "two words" }] })).toThrow(/command's name/);
  expect(() => agent({ folders: [{ path: "{home}/x", prefix: "prompts" }] })).toThrow(/prefix/);
});
