// The old site's guide addresses must still lead somewhere: its agent files moved under /guide,
// and the one page with no new page goes to the file it described.
import { test } from "node:test";
import assert from "node:assert/strict";
import { redirectFor } from "./redirects.mjs";

test("the agent files the old guide exported move under /guide", () => {
  assert.equal(redirectFor("/llms.txt"), "/guide/llms.txt");
  assert.equal(redirectFor("/llms-full.txt"), "/guide/llms-full.txt");
  assert.equal(redirectFor("/markdown/machines.md"), "/guide/machines.md");
  assert.equal(redirectFor("/markdown/api-connect.md?x=1"), "/guide/api-connect.md?x=1");
});

test("the contributing page goes to CONTRIBUTING.md on GitHub", () => {
  const to = "https://github.com/dip497/hivemind/blob/main/CONTRIBUTING.md";
  assert.equal(redirectFor("/guide/contributing/"), to);
  assert.equal(redirectFor("/guide/contributing"), to);
  assert.equal(redirectFor("/markdown/contributing.md"), to);
});

test("pages that did not move stay where they are", () => {
  for (const p of ["/", "/download", "/guide/", "/guide/machines/", "/guide/llms.txt", "/markdown/", "/guidebook"]) {
    assert.equal(redirectFor(p), null, p);
  }
});
