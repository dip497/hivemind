import { test } from "node:test";
import assert from "node:assert/strict";
import {
  htmlFileUrl,
  isHtmlPath,
} from "../../src/renderer/src/browser-open";

test("isHtmlPath recognizes html files only", () => {
  assert.equal(isHtmlPath("index.html"), true);
  assert.equal(isHtmlPath("docs/page.htm"), true);
  assert.equal(isHtmlPath("src/index.HTML"), true);
  assert.equal(isHtmlPath("src/index.ts"), false);
  assert.equal(isHtmlPath("README.md"), false);
});

test("htmlFileUrl builds an encoded file URL for local repo-relative html", () => {
  assert.equal(
    htmlFileUrl("/home/me/site", "pages/hello world.html"),
    "file:///home/me/site/pages/hello%20world.html",
  );
});

test("htmlFileUrl refuses remote workspaces and traversal", () => {
  assert.equal(htmlFileUrl("ssh://me@host/repo", "index.html"), null);
  assert.equal(htmlFileUrl("/home/me/site", "../secret.html"), null);
  assert.equal(htmlFileUrl("/home/me/site", "/tmp/other.html"), null);
});
