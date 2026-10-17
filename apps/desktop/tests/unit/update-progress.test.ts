// The installer writes for a terminal; the app says which of four things is happening.
import { test } from "node:test";
import assert from "node:assert/strict";
import { UPDATE_START, latestNightlyTag, newerNightlyTag, tagFromReleasesLatest, updateProgress, type UpdateProgress } from "../../src/shared/update-progress.ts";

/** The lines install.sh prints, in order, for an upgrade that lands in place. */
const RUN = [
  "resolving latest release of dip497/hivemind",
  "target version: v2026.9.7",
  "downloading hive CLI",
  "linked /home/u/.local/bin/hive → /home/u/.hivemind-app/hive",
  "downloading desktop AppImage",
  "extracting AppImage (no libfuse2 needed)",
  "installed launcher /home/u/.local/bin/hivemind → /home/u/.hivemind-app/hivemind-extracted/AppRun",
  "installed v2026.9.7",
];

const fold = (lines: readonly string[]): UpdateProgress[] => {
  const out: UpdateProgress[] = [];
  let p = UPDATE_START;
  for (const l of lines) out.push((p = updateProgress(l, p)));
  return out;
};

test("an upgrade in place walks check → download → install → done, naming the version", () => {
  const steps = fold(RUN);
  assert.deepEqual([...new Set(steps.map((s) => s.step))], ["check", "download", "install", "done"]);
  assert.equal(steps[2]!.label, "Downloading 2026.9.7");
  assert.equal(steps.at(-1)!.label, "Installed 2026.9.7");
  assert.equal(steps.at(-1)!.staged, undefined);
  // A line that is not a step leaves the step alone.
  assert.equal(steps[3]!.step, "download");
});

test("a download that needs a restart says so, and is the only thing left", () => {
  const staged = fold([...RUN.slice(0, 6), "hivemind is running — upgrade STAGED. Quit & reopen hivemind to apply it.", "downloaded v2026.9.7 — restart hivemind to finish"]).at(-1)!;
  assert.equal(staged.step, "done");
  assert.equal(staged.staged, true);
  assert.equal(staged.label, "Downloaded — restart to finish");
  // Asked again when it is already waiting.
  assert.equal(updateProgress("v2026.9.7 is downloaded already — restart hivemind to finish").staged, true);
});

test("nothing known yet, and noise, are both safe", () => {
  assert.deepEqual(updateProgress("some line nobody expected"), UPDATE_START);
  assert.equal(updateProgress("warn: could not reach github.com", { step: "download", label: "Downloading" }).step, "download");
});

test("where a running app cannot be replaced at all, it says what the user has to do", () => {
  // macOS and Windows: the installer upgrades the CLI and refuses the app.
  const p = updateProgress("hivemind is running - the app was NOT upgraded (Windows locks a running .exe).", { step: "download", label: "Downloading", version: "2026.9.7" });
  assert.equal(p.blocked, true);
  assert.equal(p.staged, undefined);
  assert.match(p.label, /Close hivemind/);
});

test("the tag comes out of the url GitHub's releases/latest redirects to", () => {
  assert.equal(tagFromReleasesLatest("https://github.com/dip497/hivemind/releases/tag/v2026.9.7"), "2026.9.7");
  assert.equal(tagFromReleasesLatest("https://github.com/dip497/hivemind/releases/tag/2026.9.7"), "2026.9.7");
  // Not a tag: the redirect went somewhere else, or there is no release at all.
  assert.equal(tagFromReleasesLatest("https://github.com/dip497/hivemind/releases"), null);
  assert.equal(tagFromReleasesLatest("https://github.com/login?return_to=/releases/tag/x"), null);
});

test("nightly updates follow pre-releases and their UTC day and run order", () => {
  const releases = [
    { tag_name: "v2026.10.0", prerelease: false },
    { tag_name: "nightly-20261003-12", prerelease: true },
    { tag_name: "nightly-20261003-123", prerelease: true },
    { tag_name: "nightly-20261004-1", prerelease: false },
  ];
  assert.equal(latestNightlyTag(releases), "nightly-20261003-123");
  assert.equal(newerNightlyTag("nightly-20261003-123", "nightly-20261003-12"), true);
  assert.equal(newerNightlyTag("nightly-20261003-12", "nightly-20261003-123"), false);
  assert.equal(newerNightlyTag("nightly-20261004-1", "nightly-20261003-123"), true);
  assert.equal(latestNightlyTag({}), null);
});
