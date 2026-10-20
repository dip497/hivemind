// The Plugins page lists a package that holds several plugins as one row, its members under it:
// each on only while the package is on and not switched off on its own; a package of one stays
// its plugin's row.
import { test } from "node:test";
import assert from "node:assert/strict";
import { packageRows } from "../../src/renderer/src/plugins/package-rows.ts";
import type { InstalledPackageInfo } from "../../src/shared/ipc.ts";

const kit = (on: boolean): InstalledPackageInfo => ({
  id: "@ada/kit", name: "Kit", version: "1.0.0", on,
  members: [{ kind: "tool", id: "@ada/prs", runs: "in the app" }, { kind: "widget", id: "@ada/dog", runs: "sandboxed" }, { kind: "agent-preset", id: "@ada/reviewer", runs: "as an agent's instructions" }],
  previous: null,
});
const names: Record<string, string> = { "tool:@ada/prs": "PRs", "widget:@ada/dog": "Dog" };
const nameOf = (kind: string, id: string) => names[`${kind}:${id}`];

test("a package of several is one row with its members; a package of one is not", () => {
  const rows = packageRows([kit(true), { id: "@ada/pet", name: "Pet", version: "1.0.0", on: true, members: [{ kind: "widget", id: "@ada/pet", runs: "sandboxed" }], previous: null }], {}, nameOf);
  assert.deepEqual(rows.map((r) => [r.id, r.members.map((m) => `${m.kind}:${m.name}`)]), [["@ada/kit", ["tool:PRs", "widget:Dog", "agent-preset:@ada/reviewer"]]]);
});

test("a member switched off on its own is off while its package is on; while the package is off every member is off and none can be turned on", () => {
  const states = { "widget:@ada/dog": { enabled: false } };
  const [on] = packageRows([kit(true)], states, nameOf);
  assert.deepEqual(on!.members.map((m) => [m.id, m.on, m.own?.canTurnOn ?? null]), [
    ["@ada/prs", true, true], ["@ada/dog", false, true], ["@ada/reviewer", true, null],
  ]);
  const [off] = packageRows([kit(false)], {}, nameOf);
  assert.deepEqual(off!.members.map((m) => [m.id, m.on, m.own?.canTurnOn ?? null]), [
    ["@ada/prs", false, false], ["@ada/dog", false, false], ["@ada/reviewer", false, null],
  ]);
});

test("search keeps a package when a member matches", () => {
  const matches = (q: string) => (text: string) => text.toLowerCase().includes(q);
  assert.equal(packageRows([kit(true)], {}, nameOf, matches("dog")).length, 1);
  assert.equal(packageRows([kit(true)], {}, nameOf, matches("cat")).length, 0);
});
