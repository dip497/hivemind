import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mimeFor, resolvePackageFile } from "./view-files.js";

// Serving a community view package's files, to its iframe or to a phone: containment on the REAL
// path (a symlink inside a package cannot escape it), and each file's type.
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

test("a file's type is its extension's, and anything else is bytes", () => {
  expect(mimeFor("/x/y.js")).toBe("text/javascript; charset=utf-8");
  expect(mimeFor("/x/y.bin")).toBe("application/octet-stream");
});
