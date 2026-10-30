// What each version changed, read from a changelog laid out as the project's CHANGELOG.md is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { releaseNotes } from "../../src/shared/release-notes.ts";

const CHANGELOG = `# Changelog

Intro text, not a version.

## [Unreleased]

- Added: not released yet.

## [2026.10.10] — 2026-11-02

- Added: the newest.

## [2026.10.9] — 2026-10-31

- Fixed: one.
- Fixed: two.

## [2026.10.8] — 2026-10-30

- Fixed: older.

## [2026.9.4] — 2026-09-20

- Fixed: last month.
`;

test("after an update, every version since the one last run, newest first, and nothing unreleased", () => {
  const n = releaseNotes(CHANGELOG, "2026.10.10", "2026.10.8");
  assert.deepEqual(n.map((x) => [x.version, x.date]), [["2026.10.10", "2026-11-02"], ["2026.10.9", "2026-10-31"]]);
  assert.equal(n[1]!.body, "- Fixed: one.\n- Fixed: two.");
});

test("a month's last version comes before the next month's first: versions compare by number, not by text", () => {
  assert.deepEqual(releaseNotes(CHANGELOG, "2026.10.8", "2026.9.4").map((x) => x.version), ["2026.10.8"]);
});

test("one version's own notes, and none for a version the changelog does not have", () => {
  assert.deepEqual(releaseNotes(CHANGELOG, "2026.10.9", null).map((x) => x.version), ["2026.10.9"]);
  assert.deepEqual(releaseNotes(CHANGELOG, "2026.10.7", null), []);
  assert.deepEqual(releaseNotes(CHANGELOG, "2026.10.10", "2026.10.10"), []);
});
