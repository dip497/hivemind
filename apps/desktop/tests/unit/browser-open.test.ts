import { test } from "node:test";
import assert from "node:assert/strict";
import {
  htmlFileUrl,
  isHtmlPath,
  openTargetForTerminalLink,
  webUrlForInternalBrowser,
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

test("webUrlForInternalBrowser keeps http urls for the internal browser", () => {
  assert.equal(webUrlForInternalBrowser("https://example.com/a?q=1"), "https://example.com/a?q=1");
  assert.equal(webUrlForInternalBrowser("http://localhost:5173"), "http://localhost:5173");
  assert.equal(webUrlForInternalBrowser("ftp://example.com/file"), null);
});

test("openTargetForTerminalLink routes html paths to browser and other files to app opener", () => {
  assert.deepEqual(
    openTargetForTerminalLink("/home/me/site", "./index.html:12"),
    { kind: "browser", url: "file:///home/me/site/index.html" },
  );
  assert.deepEqual(
    openTargetForTerminalLink("/home/me/site", "./src/main.ts:12:4"),
    { kind: "app", target: "./src/main.ts:12:4" },
  );
  assert.deepEqual(
    openTargetForTerminalLink("/home/me/site", "https://example.com"),
    { kind: "browser", url: "https://example.com" },
  );
});
