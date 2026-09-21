// Serving a community view package: containment on the REAL path (a symlink
// inside a package cannot escape it), the bootstrap page + nonce, the CSP.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { entryPage, entryUrl, withImportMap, mimeFor, newNonce, pluginCsp, resolvePackageFile } from "../../src/main/view-package-files";

function pkg() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hm-viewpkg-"));
  const dir = path.join(tmp, "views", "orbit");
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html>");
  fs.writeFileSync(path.join(dir, "assets", "a.png"), "png");
  fs.writeFileSync(path.join(tmp, "secret.txt"), "not yours");
  fs.symlinkSync(path.join(tmp, "secret.txt"), path.join(dir, "leak.txt"));       // file link out of the package
  fs.symlinkSync(tmp, path.join(dir, "up"));                                       // dir link out of the package
  fs.symlinkSync(path.join(dir, "assets"), path.join(dir, "inside"));              // dir link that stays inside
  return { tmp, dir };
}

test("resolvePackageFile: files inside the package are served, traversal and symlink escapes are 403", () => {
  const { tmp, dir } = pkg();
  assert.deepEqual(resolvePackageFile(dir, "index.html"), { status: 200, abs: fs.realpathSync(path.join(dir, "index.html")) });
  assert.deepEqual(resolvePackageFile(dir, "assets/a.png").status, 200);
  assert.deepEqual(resolvePackageFile(dir, "inside/a.png").status, 200);          // link that resolves inside: fine
  assert.deepEqual(resolvePackageFile(dir, "../secret.txt"), { status: 403 });     // lexical traversal
  assert.deepEqual(resolvePackageFile(dir, "leak.txt"), { status: 403 });          // symlinked file → outside
  assert.deepEqual(resolvePackageFile(dir, "up/secret.txt"), { status: 403 });     // symlinked dir → outside
  assert.deepEqual(resolvePackageFile(dir, "missing.js"), { status: 404 });
  assert.deepEqual(resolvePackageFile(dir, "assets"), { status: 404 });            // a directory is not a file
  assert.deepEqual(resolvePackageFile(dir, ""), { status: 404 });
  assert.deepEqual(resolvePackageFile(path.join(tmp, "nope"), "index.html"), { status: 404 });
  fs.rmSync(tmp, { recursive: true, force: true });
});

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
  assert.equal(mimeFor("/x/y.js"), "text/javascript; charset=utf-8");
  assert.equal(mimeFor("/x/y.bin"), "application/octet-stream");
});

test("every plugin document gets the SDK's import map first, under the response nonce", () => {
  const page = withImportMap('<!doctype html><html><HEAD lang="en"><script type="module" src="./v.js"></script></head></html>', "n0");
  const map = page.match(/<script type="importmap" nonce="n0">(.*?)<\/script>/)!;
  assert.deepEqual(JSON.parse(map[1]!), { imports: { "@hivemind/view-sdk": "/__sdk.js" } });
  assert.ok(page.indexOf("importmap") > page.indexOf("<HEAD") && page.indexOf("importmap") < page.indexOf('type="module"'));
  assert.ok(withImportMap("<p>no head</p>", "n0").startsWith('<script type="importmap"'));
});
