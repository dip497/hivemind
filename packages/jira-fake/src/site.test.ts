import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES_DIR, loadSites, siteProblems, type Site } from "./index.js";

// The fake Jira answers every sync test from these sites, so an inconsistent site (a transition
// to a status outside its workflow, an issue in a status its type can't have) would make the
// sync look broken when the fixture is. And the design (§15) names the shapes the suite must
// cover: losing one silently drops that coverage.
describe("fixture sites", () => {
  const sites = loadSites();

  test("every site parses and is internally consistent", () => {
    expect(sites.size).toBeGreaterThanOrEqual(4);
    for (const [name, site] of sites) expect({ name, problems: siteProblems(site) }).toEqual({ name, problems: [] });
  });

  const all = [...sites.values()];
  const transitions = (s: Site) => Object.values(s.workflows).flatMap((w) => w.transitions);
  const covers: [string, (s: Site) => boolean][] = [
    ["company-managed Scrum with per-type workflows", (s) => s.boards.some((b) => b.type === "scrum") && s.projects.some((p) => p.style === "classic" && new Set(p.issueTypes.map((t) => t.workflow)).size > 1)],
    ["team-managed Kanban", (s) => s.boards.some((b) => b.type === "kanban") && s.projects.some((p) => p.style === "next-gen")],
    ["no board", (s) => s.deployment === "Cloud" && s.boards.length === 0],
    ["Data Center v2 with wiki markup", (s) => s.deployment === "DataCenter" && s.issues.some((i) => i.description !== null && "wiki" in i.description)],
    ["a screen with a required resolution", (s) => transitions(s).some((t) => t.hasScreen && t.fields.resolution?.required === true)],
    ["a required field that is not on the screen", (s) => transitions(s).some((t) => t.hiddenRequired !== undefined)],
    ["a refusal by a condition", (s) => transitions(s).some((t) => t.condition !== undefined)],
    ["a shortest path longer than three hops", (s) => Object.values(s.workflows).some((w) => w.statuses.some((a) => w.statuses.some((b) => { const n = hops(w, a, b); return n > 3 && n !== Infinity; })))],
    ["a moved key", (s) => s.issues.some((i) => i.previousKeys.length > 0)],
    ["a restricted issue", (s) => s.issues.some((i) => i.restricted)],
    ["a deleted issue", (s) => s.issues.some((i) => i.deleted)],
    ["a 429 with Retry-After", (s) => s.faults.some((f) => f.status === 429 && "Retry-After" in f.headers)],
    ["a status with no category", (s) => s.statuses.some((st) => st.statusCategory.key === "undefined")],
    ["a 9-status workflow", (s) => Object.values(s.workflows).some((w) => w.statuses.length === 9)],
  ];
  test.each(covers)("some site covers %s", (_label, has) => {
    expect(all.some(has)).toBe(true);
  });
});

/** Shortest number of transitions from `a` to `b` (Infinity when unreachable). */
function hops(w: Site["workflows"][string], a: string, b: string): number {
  const seen = new Map([[a, 0]]);
  const queue = [a];
  while (queue.length) {
    const at = queue.shift()!;
    if (at === b) return seen.get(at)!;
    for (const t of w.transitions) {
      if ((t.from === "*" || t.from.includes(at)) && !seen.has(t.to)) { seen.set(t.to, seen.get(at)! + 1); queue.push(t.to); }
    }
  }
  return Infinity;
}

// Atlassian's own response examples, kept as they were published (see fixtures/README.md).
test("spec examples are valid JSON", () => {
  const dir = join(FIXTURES_DIR, "spec-examples");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  expect(files.length).toBeGreaterThan(20);
  for (const f of files) expect(() => JSON.parse(readFileSync(join(dir, f), "utf8"))).not.toThrow();
});
