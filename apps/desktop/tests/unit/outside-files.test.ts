import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openOutside, outsidePicture, outsideStat, outsideTextRead, outsideTextWrite, personOpens } from "../../src/main/outside-files";

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "outside-files-")));
fs.writeFileSync(path.join(dir, "crop2.png"), "png!");
fs.writeFileSync(path.join(dir, "secret.txt"), "secret");
fs.symlinkSync(path.join(dir, "secret.txt"), path.join(dir, "looks.png"));
fs.symlinkSync("/dev/zero", path.join(dir, "zero.png"));
execFileSync("mkfifo", [path.join(dir, "pipe.png")]);
fs.symlinkSync(path.join(dir, "pipe.png"), path.join(dir, "to-pipe.png"));
fs.writeFileSync(path.join(dir, "notes.md"), "a\r\nb\r\n");
fs.writeFileSync(path.join(dir, "tool.bin.md"), Buffer.from([0x61, 0, 0x62]));
fs.writeFileSync(path.join(dir, "big.log"), Buffer.alloc(5 * 1024 * 1024 + 1, "a"));
fs.writeFileSync(path.join(dir, "run.exe"), "MZ");
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
const at = (name: string) => path.join(dir, name);

test("nothing the person did not open is read, saved or handed on", async () => {
  const handed: string[] = [];
  await assert.rejects(outsidePicture(at("crop2.png")), /not opened by you/);
  assert.deepEqual(await outsideTextRead(at("notes.md")), { error: `not opened by you: click ${at("notes.md")} in a terminal to open it` });
  assert.equal((await outsideTextWrite(at("notes.md"), "gone")).ok, false);
  assert.equal((await openOutside(at("notes.md"), async (p) => { handed.push(p); return ""; })).ok, false);
  assert.deepEqual([fs.readFileSync(at("notes.md"), "utf8"), handed], ["a\r\nb\r\n", []]);
});

test("a text file the person opened is read as it is and saved back; a binary or too large one is refused", async () => {
  for (const name of ["notes.md", "tool.bin.md", "big.log"]) await personOpens(at(name));
  assert.deepEqual(await outsideTextRead(at("notes.md")), { text: "a\r\nb\r\n" });
  assert.deepEqual(await outsideTextWrite(at("notes.md"), "c\r\n"), { ok: true });
  assert.equal(fs.readFileSync(at("notes.md"), "utf8"), "c\r\n");
  assert.deepEqual(await outsideTextRead(at("tool.bin.md")), { error: "This file is binary", code: "UNSUPPORTED" });
  assert.deepEqual(await outsideTextRead(at("big.log")), { error: "This file is too large to edit, 5.0 MB", code: "FILE_TOO_BIG" });
});

test("a picture outside the workspace is read by its real path", async () => {
  for (const name of ["crop2.png", "looks.png", "zero.png", "to-pipe.png", "secret.txt", "run.exe"]) await personOpens(at(name));
  assert.deepEqual(await outsidePicture(path.join(dir, "crop2.png")), { base64: Buffer.from("png!").toString("base64"), size: 4 });
  assert.deepEqual(await outsideStat(path.join(dir, "crop2.png")), { kind: "file", size: 4, path: path.join(dir, "crop2.png") });
});

test("a picture's name on what is not a picture, a device or a pipe is refused unread", async () => {
  await assert.rejects(outsidePicture(path.join(dir, "looks.png")), /not a picture/);
  await assert.rejects(outsidePicture(path.join(dir, "zero.png")), /not opened by you/);
  await assert.rejects(outsidePicture(path.join(dir, "to-pipe.png")), /not opened by you/);
  fs.writeFileSync(at("swap.png"), "png!");
  await personOpens(at("swap.png"));
  fs.rmSync(at("swap.png"));
  execFileSync("mkfifo", [at("swap.png")]);
  await assert.rejects(outsidePicture(at("swap.png")), /not a file/);
  assert.equal((await outsideTextWrite(at("swap.png"), "x")).ok, false);
  assert.equal(await outsideStat(path.join(dir, "pipe.png")), null);
  await assert.rejects(outsidePicture("crop2.png"), /nothing at/);
});

test("only a viewable file or a folder is handed to the system's app", async () => {
  const handed: string[] = [];
  const openPath = async (p: string) => { handed.push(p); return ""; };
  assert.deepEqual(await openOutside(path.join(dir, "secret.txt"), openPath), { ok: true });
  assert.deepEqual(await openOutside(path.join(dir, "run.exe"), openPath), { ok: false, error: `outside the workspace: ${path.join(dir, "run.exe")}` });
  assert.deepEqual(await openOutside(path.join(dir, "gone.pdf"), openPath), { ok: false, error: `nothing at ${path.join(dir, "gone.pdf")}` });
  assert.deepEqual(handed, [path.join(dir, "secret.txt")]);
});

test("what the person opened is still theirs after the app restarts; a list that cannot be read keeps nothing", async () => {
  const kept = path.join(dir, "opened.json");
  fs.writeFileSync(at("after.md"), "kept");
  const before = await import("../../src/main/outside-files.ts?before-restart");
  before.keepOpenedIn(kept);
  await before.personOpens(at("after.md"));
  const after = await import("../../src/main/outside-files.ts?after-restart");
  after.keepOpenedIn(kept);
  assert.deepEqual(await after.outsideTextRead(at("after.md")), { text: "kept" });
  fs.writeFileSync(kept, "{not a list");
  const broken = await import("../../src/main/outside-files.ts?broken-list");
  broken.keepOpenedIn(kept);
  assert.match((await broken.outsideTextRead(at("after.md")) as { error: string }).error, /not opened by you/);
});
