// Remote commands are shell strings; running them with the local /bin/sh is what sshd does on the far side.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_EDIT_BYTES, RemoteFs, type RunRemote } from "../../src/main/remote/fs.ts";

const unix = process.platform !== "win32";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hrfs-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const run: RunRemote = async (cmd, input) => {
  const r = spawnSync("/bin/sh", ["-c", cmd], { input: input ?? "", env: { ...process.env, HOME: root } });
  return { stdout: r.stdout, stderr: r.stderr.toString("utf8"), code: r.status };
};
const rfs = new RemoteFs(run);

test("readdir: dirs first, dotfiles included, awkward names intact, symlinks not followed", { skip: !unix }, async () => {
  const d = path.join(root, "list");
  fs.mkdirSync(path.join(d, "sub dir"), { recursive: true });
  fs.mkdirSync(path.join(d, ".hidden"));
  for (const n of ["a.txt", "it's $(evil).md", "new\nline", "-dash"]) fs.writeFileSync(path.join(d, n), "x");
  fs.symlinkSync(path.join(d, "sub dir"), path.join(d, "link"));
  const got = await rfs.readdir(d);
  assert.deepEqual(got, [
    { name: ".hidden", isDir: true, isSymlink: false },
    { name: "sub dir", isDir: true, isSymlink: false },
    { name: "-dash", isDir: false, isSymlink: false },
    { name: "a.txt", isDir: false, isSymlink: false },
    { name: "it's $(evil).md", isDir: false, isSymlink: false },
    { name: "link", isDir: false, isSymlink: true },
    { name: "new\nline", isDir: false, isSymlink: false },
  ]);
  assert.deepEqual(await rfs.readdir(path.join(d, "sub dir")), []);
});

test("home and realpath", { skip: !unix }, async () => {
  assert.equal(await rfs.home(), root);
  fs.mkdirSync(path.join(root, "real"), { recursive: true });
  fs.symlinkSync(path.join(root, "real"), path.join(root, "alias"));
  assert.equal(await rfs.realpath(path.join(root, "alias")), fs.realpathSync(path.join(root, "real")));
  await assert.rejects(rfs.realpath(path.join(root, "missing")));
});

test("readFile round-trips utf8 and refuses files over the edit limit", { skip: !unix }, async () => {
  const f = path.join(root, "text é.txt");
  fs.writeFileSync(f, "héllo\nwörld\n");
  assert.equal(await rfs.readFile(f), "héllo\nwörld\n");
  const big = path.join(root, "big.bin");
  fs.writeFileSync(big, Buffer.alloc(MAX_EDIT_BYTES + 1));
  await assert.rejects(rfs.readFile(big), /too large/);
  await assert.rejects(rfs.readFile(path.join(root, "nope")));
});

test("writeFile keeps the file's mode (an edited script stays executable)", { skip: !unix }, async () => {
  const f = path.join(root, "run.sh");
  fs.writeFileSync(f, "old");
  fs.chmodSync(f, 0o755);
  await rfs.writeFile(f, "#!/bin/sh\necho new 'quoted' $HOME\n");
  assert.equal(fs.readFileSync(f, "utf8"), "#!/bin/sh\necho new 'quoted' $HOME\n");
  assert.equal(fs.statSync(f).mode & 0o777, 0o755);
});
