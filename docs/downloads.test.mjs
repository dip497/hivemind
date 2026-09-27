// A download route is a promise to keep: the names below are the ones the release workflow
// publishes with no version in them, so the link still resolves after the next release.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DOWNLOADS, downloadFor } from "./downloads.mjs";

test("every route points at a name the release publishes, with no version in it", () => {
  const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  for (const [key, url] of Object.entries(DOWNLOADS)) {
    if (key === "notes") continue;
    const asset = url.split("/").pop();
    assert.ok(!/\d+\.\d+\.\d+/.test(asset), `${key} carries a version: ${asset}`);
    assert.ok(workflow.includes(asset), `the release workflow does not publish ${asset}`);
    assert.match(url, /^https:\/\/github\.com\/dip497\/hivemind\/releases\/latest\/download\//);
  }
});

test("a download path is answered, anything else is not", () => {
  assert.equal(downloadFor("/download/linux"), DOWNLOADS.linux);
  assert.equal(downloadFor("/download/linux/"), DOWNLOADS.linux);
  assert.equal(downloadFor("/download/cli-macos-arm64?src=readme"), DOWNLOADS["cli-macos-arm64"]);
  for (const p of ["/download", "/download/", "/download/nope", "/", "/install.sh", "/download/../etc/passwd", "/download/__proto__", "/download/constructor"]) {
    assert.equal(downloadFor(p), null, p);
  }
});
