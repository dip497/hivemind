// The old site's guide addresses must still lead somewhere: its Markdown pages moved under /guide,
// and the one page with no new page goes to the file it described. A page has one address.
import { test } from "node:test";
import assert from "node:assert/strict";
import { redirectFor } from "./redirects.mjs";

test("the Markdown pages the old guide exported move under /guide", () => {
  assert.equal(redirectFor("/markdown/machines.md"), "/guide/machines.md");
  assert.equal(redirectFor("/markdown/api-connect.md?x=1"), "/guide/api-connect.md?x=1");
});

test("the contributing page goes to CONTRIBUTING.md on GitHub", () => {
  const to = "https://github.com/dip497/hivemind/blob/main/CONTRIBUTING.md";
  assert.equal(redirectFor("/guide/contributing/"), to);
  assert.equal(redirectFor("/guide/contributing"), to);
  assert.equal(redirectFor("/markdown/contributing.md"), to);
});

test("a page's index.html is the page's own address", () => {
  assert.equal(redirectFor("/index.html"), "/");
  assert.equal(redirectFor("/guide/index.html"), "/guide/");
  assert.equal(redirectFor("/guide/faq/index.html?x=1"), "/guide/faq/?x=1");
  assert.equal(redirectFor("//evil.example/index.html"), null);
  assert.equal(redirectFor("/\\evil.example/index.html"), null);
});

test("pages that did not move stay where they are", () => {
  for (const p of ["/", "/download", "/guide/", "/guide/machines/", "/guide/llms.txt", "/llms.txt", "/llms-full.txt", "/markdown/", "/guidebook", "/guide/index.md"]) {
    assert.equal(redirectFor(p), null, p);
  }
});
