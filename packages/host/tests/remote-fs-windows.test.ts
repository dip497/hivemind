// A Windows machine's files, as its ssh runs what the app sends: the command line PowerShell
// takes, run here by PowerShell 7 (`pwsh`), with this computer's folders standing in for a PC's.
// Skips where no `pwsh` is installed.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RemoteFs, type RunRemote } from "../src/remote/fs.ts";

const pwsh = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status === 0;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hrfs-win-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const run: RunRemote = async (cmd, input) => {
  const [program, ...args] = cmd.split(" ");
  assert.equal(program, "powershell");
  const r = spawnSync("pwsh", args, { input: input ?? "", cwd: root, env: { ...process.env, HOME: root } });
  return { stdout: r.stdout, stderr: r.stderr.toString("utf8"), code: r.status };
};
const rfs = new RemoteFs(run, true);

test("a Windows machine's folder is listed folders first, hidden ones and awkward names intact, a link not followed", { skip: !pwsh }, async () => {
  const d = path.join(root, "list");
  fs.mkdirSync(path.join(d, "sub dir"), { recursive: true });
  fs.mkdirSync(path.join(d, ".hidden"));
  for (const n of ["a.txt", "it's $(evil).md", "naïve ünïcode.txt"]) fs.writeFileSync(path.join(d, n), "x");
  fs.symlinkSync(path.join(d, "sub dir"), path.join(d, "link"));
  assert.deepEqual(await rfs.readdir(d), [
    { name: ".hidden", isDir: true, isSymlink: false },
    { name: "sub dir", isDir: true, isSymlink: false },
    { name: "a.txt", isDir: false, isSymlink: false },
    { name: "it's $(evil).md", isDir: false, isSymlink: false },
    { name: "link", isDir: false, isSymlink: true },
    { name: "naïve ünïcode.txt", isDir: false, isSymlink: false },
  ]);
  await assert.rejects(rfs.readdir(path.join(d, "gone")));
});

test("its home, a folder's real path, and a file read and written back whole", { skip: !pwsh }, async () => {
  assert.equal(await rfs.home(), root);
  fs.mkdirSync(path.join(root, "real"), { recursive: true });
  assert.equal(await rfs.realpath(path.join(root, "real")), fs.realpathSync(path.join(root, "real")));
  const file = path.join(root, "notes.md");
  fs.writeFileSync(file, "old text that is longer than the new");
  const text = "# Ünïcode ✓\n$(not run) 'quoted'\r\nend";
  await rfs.writeFile(file, text);
  assert.equal(fs.readFileSync(file, "utf8"), text);
  assert.equal(await rfs.readFile(file), text);
});

test("which programs it has, and a photo kept where its agents read it", { skip: !pwsh }, async () => {
  assert.deepEqual(await rfs.found(["sh", "no-such-program-here", "it's"]), ["sh"]);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255, 10, 13]);
  const at = await rfs.keep("shot.png", png, "t1");
  assert.equal(at, path.join(root, ".hivemind", "photos", "t1", "shot.png"));
  assert.deepEqual(fs.readFileSync(at), png);
});
