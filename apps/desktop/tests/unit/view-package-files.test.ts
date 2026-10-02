// Serving a community view package: the bootstrap page + nonce, the CSP. Which file a request
// may read, and its type, are @hivemind/core's (view-files.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { entryPage, entryUrl, withImportMap, newNonce, pluginCsp } from "../../src/main/view-package-files";

test("the bootstrap page carries the response nonce and refuses odd entries; the CSP has no unsafe-inline for scripts", () => {
  const nonce = newNonce();
  assert.match(nonce, /^[A-Za-z0-9+/]+=*$/);
  assert.notEqual(nonce, newNonce());
  const html = entryPage("dist/view.js", nonce)!;
  assert.match(html, new RegExp(`<script type="module" nonce="${nonce.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" src="\\./dist/view\\.js"></script>`));
  assert.equal(entryPage("../x.js", nonce), null);
  assert.equal(entryPage("/abs/x.js", nonce), null);
  assert.equal(entryPage("x.html", nonce), null);
  const csp = pluginCsp(nonce);
  assert.match(csp, new RegExp(`script-src hm-view: 'nonce-${nonce.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}' 'wasm-unsafe-eval'`));
  assert.doesNotMatch(csp.split(";").find((d) => d.trim().startsWith("script-src"))!, /unsafe-inline/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /frame-src 'none'/);
  assert.equal(entryUrl("orbit", "index.html"), "hm-view://orbit/index.html");
  assert.equal(entryUrl("orbit", "dist/view.js"), "hm-view://orbit/__entry.html?js=dist%2Fview.js");
  // A scoped view gets an origin of its own: `@` and `/` would make the owner the host.
  assert.equal(entryUrl("@dip497/board", "index.html"), "hm-view://dip497--board/index.html");
  assert.equal(new URL(entryUrl("@dip497/board", "index.html")).host, "dip497--board");
  assert.notEqual(new URL(entryUrl("@dip497/board", "index.html")).host, new URL(entryUrl("@dip497/queue", "index.html")).host);
});

test("every plugin document gets the SDK's import map first, under the response nonce", () => {
  const page = withImportMap('<!doctype html><html><HEAD lang="en"><script type="module" src="./v.js"></script></head></html>', "n0");
  const map = page.match(/<script type="importmap" nonce="n0">(.*?)<\/script>/)!;
  assert.deepEqual(JSON.parse(map[1]!), { imports: { "@hivemind/view-sdk": "/__sdk.js" } });
  assert.ok(page.indexOf("importmap") > page.indexOf("<HEAD") && page.indexOf("importmap") < page.indexOf('type="module"'));
  assert.ok(withImportMap("<p>no head</p>", "n0").startsWith('<script type="importmap"'));
});
