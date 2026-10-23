import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { entryPage, entryUrl, mimeFor, newNonce, ownFiles, pageOf, pluginCsp, resolvePackageFile, serveViewFile, withImportMap, withOwnFiles } from "./view-files.js";

// Serving a community view package's files, to its iframe or to a phone: containment on the REAL
// path (a symlink inside a package cannot escape it), and each file's type; the bootstrap page and
// its nonce, the CSP, the SDK's import map; and what each request is served, the same on every
// screen (moved here with the serving from the desktop's view-package-files, P8 step 3).
let tmp: string;
let dir: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hm-viewpkg-"));
  dir = path.join(tmp, "views", "orbit");
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html>");
  fs.writeFileSync(path.join(dir, "assets", "a.png"), "png");
  fs.writeFileSync(path.join(tmp, "secret.txt"), "not yours");
  fs.symlinkSync(path.join(tmp, "secret.txt"), path.join(dir, "leak.txt"));       // file link out of the package
  fs.symlinkSync(tmp, path.join(dir, "up"));                                       // dir link out of the package
  fs.symlinkSync(path.join(dir, "assets"), path.join(dir, "inside"));              // dir link that stays inside
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("resolvePackageFile: files inside the package are served, traversal and symlink escapes are 403", () => {
  expect(resolvePackageFile(dir, "index.html")).toEqual({ status: 200, abs: fs.realpathSync(path.join(dir, "index.html")) });
  expect(resolvePackageFile(dir, "assets/a.png").status).toBe(200);
  expect(resolvePackageFile(dir, "inside/a.png").status).toBe(200);          // link that resolves inside: fine
  expect(resolvePackageFile(dir, "../secret.txt")).toEqual({ status: 403 });     // lexical traversal
  expect(resolvePackageFile(dir, "leak.txt")).toEqual({ status: 403 });          // symlinked file → outside
  expect(resolvePackageFile(dir, "up/secret.txt")).toEqual({ status: 403 });     // symlinked dir → outside
  expect(resolvePackageFile(dir, "missing.js")).toEqual({ status: 404 });
  expect(resolvePackageFile(dir, "assets")).toEqual({ status: 404 });            // a directory is not a file
  expect(resolvePackageFile(dir, "")).toEqual({ status: 404 });
  expect(resolvePackageFile(path.join(tmp, "nope"), "index.html")).toEqual({ status: 404 });
});

test("a view reads its own files only: another view's folder beside it, even one whose name starts with its own, is 403", () => {
  for (const other of ["tasks", "orbit2"]) {
    fs.mkdirSync(path.join(tmp, "views", other), { recursive: true });
    fs.writeFileSync(path.join(tmp, "views", other, "data.json"), "{}");
    expect(resolvePackageFile(dir, `../${other}/data.json`)).toEqual({ status: 403 });
  }
});

test("a view may fetch from its own address and nowhere else: not another view's, not the scheme, not 'self' in a tab", () => {
  const connect = (csp: string) => csp.split("; ").find((d) => d.startsWith("connect-src "));
  expect(ownFiles("@ada/graph")).toBe("hm-view://ada--graph");
  expect(connect(pluginCsp("n", ownFiles("@ada/graph")))).toBe("connect-src hm-view://ada--graph");
  // Without an address, as on a phone, it fetches nothing.
  expect(connect(pluginCsp("n"))).toBe("connect-src 'none'");
  // A browser tab serves every view under one server: the view's own path there, and only connect-src changes.
  const tab = withOwnFiles(pluginCsp("n", ownFiles("orbit")), "https://box:7000/hm-view/key/orbit/");
  expect(connect(tab)).toBe("connect-src https://box:7000/hm-view/key/orbit/");
  expect(tab.replace(connect(tab)!, "")).toBe(pluginCsp("n", ownFiles("orbit")).replace("connect-src hm-view://orbit", ""));
});

test("a file's type is its extension's, and anything else is bytes", () => {
  expect(mimeFor("/x/y.js")).toBe("text/javascript; charset=utf-8");
  expect(mimeFor("/x/y.bin")).toBe("application/octet-stream");
});

test("the bootstrap page carries the response nonce, is laid out at its screen's width, and refuses odd entries; the CSP has no unsafe-inline for scripts", () => {
  const nonce = newNonce();
  expect(nonce).toMatch(/^[A-Za-z0-9+/]+=*$/);
  expect(nonce).not.toBe(newNonce());
  const html = entryPage("dist/view.js", nonce)!;
  expect(html).toMatch(new RegExp(`<script type="module" nonce="${escape(nonce)}" src="\\./dist/view\\.js"></script>`));
  expect(html).toContain(`<meta name="viewport" content="width=device-width, initial-scale=1">`);
  // A body an Android web view gives no height must not hide the view's content.
  expect(html).not.toContain("overflow:hidden");
  expect(entryPage("../x.js", nonce)).toBeNull();
  expect(entryPage("/abs/x.js", nonce)).toBeNull();
  expect(entryPage("x.html", nonce)).toBeNull();
  const csp = pluginCsp(nonce);
  // The view's own origin (a phone's web view) and the app's scheme (its sandboxed iframe), and nothing else.
  expect(csp).toMatch(new RegExp(`script-src 'self' hm-view: 'nonce-${escape(nonce)}' 'wasm-unsafe-eval'`));
  expect(csp.split(";").find((d) => d.trim().startsWith("script-src"))!).not.toMatch(/unsafe-inline/);
  expect(csp).toMatch(/connect-src 'none'/);
  expect(csp).toMatch(/frame-src 'none'/);
  expect(entryUrl("orbit", "index.html")).toBe("hm-view://orbit/index.html");
  expect(entryUrl("orbit", "dist/view.js")).toBe("hm-view://orbit/__entry.html?js=dist%2Fview.js");
  // A scoped view gets an origin of its own: `@` and `/` would make the owner the host.
  expect(entryUrl("@someone/notes", "index.html")).toBe("hm-view://someone--notes/index.html");
  expect(new URL(entryUrl("@someone/notes", "index.html")).host).toBe("someone--notes");
  expect(new URL(entryUrl("@someone/notes", "index.html")).host).not.toBe(new URL(entryUrl("@someone/tasks", "index.html")).host);
});

test("every plugin document gets the SDK's import map first, under the response nonce, naming the SDK from where the page is", () => {
  const html = '<!doctype html><html><HEAD lang="en"><script type="module" src="./v.js"></script></head></html>';
  const page = withImportMap(html, "n0", "index.html");
  const map = (p: string) => JSON.parse(p.match(/<script type="importmap" nonce="n0">(.*?)<\/script>/)![1]!);
  // Relative, so it is the view's own SDK wherever the view is served: at an origin's root or under a path (a browser tab).
  expect(map(page)).toEqual({ imports: { "@hivemind/view-sdk": "./__sdk.js" } });
  expect(map(withImportMap(html, "n0", "pages/settings/one.html"))).toEqual({ imports: { "@hivemind/view-sdk": "../../__sdk.js" } });
  expect(page.indexOf("importmap") > page.indexOf("<HEAD") && page.indexOf("importmap") < page.indexOf('type="module"')).toBe(true);
  expect(withImportMap("<p>no head</p>", "n0", "index.html").startsWith('<script type="importmap"')).toBe(true);
});

test("a screen elsewhere loads a view's own page, or for a `.js` entry the page that runs it", () => {
  expect(pageOf("index.html")).toBe("index.html");
  expect(pageOf("dist/view.js")).toBe("__entry.html");
});

test("each request is served as on every screen: the SDK, the page running the entry, a page with the import map under its own nonce, a file as it is, and nothing else", async () => {
  fs.writeFileSync(path.join(dir, "view.js"), "export {};");
  const sdk = async () => "export const connect = () => {};";
  const serve = (rel: string, js: string | null = "view.js") => serveViewFile(dir, rel, { js, sdk });
  /** The nonce a response's policy names, which the page it carries must be tagged with. */
  const nonceOf = (csp: string) => csp.match(/'nonce-([^']+)'/)![1]!;

  const sdkFile = await serve("__sdk.js");
  expect(sdkFile).toMatchObject({ status: 200, type: "text/javascript; charset=utf-8", text: "export const connect = () => {};" });

  const entry = await serve("__entry.html");
  if (entry.status !== 200 || !("text" in entry)) throw new Error(`the entry page: ${entry.status}`);
  expect(entry.type).toBe("text/html; charset=utf-8");
  const nonce = nonceOf(entry.csp);
  expect(entry.csp).toBe(pluginCsp(nonce));
  expect(entry.text).toContain(`<script type="importmap" nonce="${nonce}">`);
  expect(entry.text).toContain(`<script type="module" nonce="${nonce}" src="./view.js"></script>`);
  expect(await serve("__entry.html", null)).toEqual({ status: 400 });
  expect(await serve("__entry.html", "../x.js")).toEqual({ status: 400 });

  const page = await serve("index.html");
  if (page.status !== 200 || !("text" in page)) throw new Error(`the page: ${page.status}`);
  expect(page.text).toBe(withImportMap("<!doctype html>", nonceOf(page.csp), "index.html"));
  expect(nonceOf(page.csp)).not.toBe(nonce);
  fs.mkdirSync(path.join(dir, "pages"), { recursive: true });
  fs.writeFileSync(path.join(dir, "pages", "one.html"), "<!doctype html>");
  const nested = await serve("pages/one.html");
  if (nested.status !== 200 || !("text" in nested)) throw new Error(`the nested page: ${nested.status}`);
  expect(nested.text).toContain('"@hivemind/view-sdk":"../__sdk.js"');

  expect(await serve("assets/a.png")).toMatchObject({ status: 200, type: "image/png", file: fs.realpathSync(path.join(dir, "assets", "a.png")) });
  // Every response names where the view may fetch, when the screen gives it one.
  const own = await serveViewFile(dir, "assets/a.png", { js: null, sdk, files: ownFiles("orbit") });
  if (own.status !== 200) throw new Error(`the file: ${own.status}`);
  expect(own.csp).toBe(pluginCsp(nonceOf(own.csp), ownFiles("orbit")));
  expect(await serve("leak.txt")).toEqual({ status: 403 });
  expect(await serve("missing.js")).toEqual({ status: 404 });
});
