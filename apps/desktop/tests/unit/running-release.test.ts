// Which release an installed app is, by the folder each installer unpacks it into.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runningRelease } from "../../src/shared/running-release.ts";

test("an app runs as the release its folder names, on Linux, Windows, a nightly and a build from source; anywhere else, its own version", () => {
  assert.equal(runningRelease("/home/u/.hivemind-app/versions/v2026.10.9/hivemind", "2026.10.9"), "v2026.10.9");
  assert.equal(runningRelease("/home/u/.hivemind-app/versions/nightly-20261101-7/hivemind", "2026.10.9"), "nightly-20261101-7");
  assert.equal(runningRelease("C:\\Users\\u\\AppData\\Local\\hivemind\\app-2026.10.9\\hivemind.exe", "2026.10.9"), "v2026.10.9");
  assert.equal(runningRelease("C:\\Users\\u\\AppData\\Local\\hivemind\\app-nightly-20261101-7\\hivemind.exe", "2026.10.9"), "nightly-20261101-7");
  assert.equal(runningRelease("C:\\Users\\u\\AppData\\Local\\hivemind\\app-dev-20261101120000\\hivemind.exe", "2026.10.9"), "dev-20261101120000");
  // Started from a build before versions/, or from source: what it says it is.
  assert.equal(runningRelease("/home/u/.hivemind-app/hivemind-extracted/hivemind", "2026.10.8"), "v2026.10.8");
});
