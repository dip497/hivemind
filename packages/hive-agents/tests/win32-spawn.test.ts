/**
 * The win32 spawn resolution, asserted from any host: platform, PATH/PATHEXT
 * and the filesystem are all injected, so none of this depends on where bun
 * happens to be running. Path strings the host join() produces are normalized
 * before comparison (on a POSIX host `path.join("C:\\tools", "x")` mixes
 * separators — production always runs this on the real win32).
 */
import { expect, test } from "bun:test";
import { findBin, resolveWindowsSpawn } from "../src/discover.js";

const norm = (f: string): string => f.toLowerCase().replace(/\//g, "\\");
const fakeFs = (files: string[]) => {
  const set = new Set(files.map(norm));
  return (f: string): boolean => set.has(norm(f));
};
const DIRS = ["C:\\tools", "C:\\bin"];

test("a bare agent name resolves to its .cmd shim, re-parented onto cmd.exe", () => {
  const isFile = fakeFs(["C:\\tools\\claude.cmd"]);
  const r = resolveWindowsSpawn("claude", ["--version"], { Path: DIRS.join(";") }, { platform: "win32", isFile });
  expect(r.file).toBe("cmd.exe"); // no ComSpec in the env → the default
  // A plain string: node-pty passes that through as the raw command line, an array it re-quotes.
  expect(typeof r.args).toBe("string");
  const raw = r.args as string;
  expect(raw.startsWith("/d /s /c ")).toBe(true);
  expect(norm(raw)).toContain("\"c:\\tools\\claude.cmd\"");
});

test("ComSpec wins over the cmd.exe default, read case-insensitively", () => {
  const isFile = fakeFs(["C:\\tools\\claude.cmd"]);
  const r = resolveWindowsSpawn("claude", [], { PATH: DIRS.join(";"), COMSPEC: "C:\\Windows\\system32\\cmd.exe" }, { platform: "win32", isFile });
  expect(r.file).toBe("C:\\Windows\\system32\\cmd.exe");
});

test("an .exe hit is spawned directly, argv untouched", () => {
  const isFile = fakeFs(["C:\\bin\\claude.exe"]);
  const r = resolveWindowsSpawn("claude", ["-p", "hi"], { Path: DIRS.join(";") }, { platform: "win32", isFile });
  expect(norm(r.file)).toBe("c:\\bin\\claude.exe");
  expect(r.args).toEqual(["-p", "hi"]);
});

test("a cmd that already names a path is never rewritten", () => {
  const spec = { cmd: "C:\\tools\\claude.cmd", args: ["--x"] };
  const r = resolveWindowsSpawn(spec.cmd, spec.args, {}, { platform: "win32", isFile: () => false });
  expect(r).toEqual({ file: spec.cmd, args: spec.args });
  // And off Windows nothing happens at all, even for a bare name.
  const posix = resolveWindowsSpawn("claude", [], {}, { platform: "linux", isFile: () => false });
  expect(posix).toEqual({ file: "claude", args: [] });
});

test("PATH and PATHEXT are found under Windows casing (`Path`, `pathext`)", () => {
  const isFile = fakeFs(["C:\\tools\\claude.cmd"]);
  const r = resolveWindowsSpawn("claude", [], { Path: DIRS.join(";"), pathext: ".CMD" }, { platform: "win32", isFile });
  expect(norm(r.file)).toBe("cmd.exe");
  expect(norm(r.args as string)).toContain("claude.cmd");
  // A PATHEXT that excludes shims leaves the name unresolved (bare passthrough).
  const none = resolveWindowsSpawn("claude", [], { Path: DIRS.join(";"), PATHEXT: ".EXE" }, { platform: "win32", isFile });
  expect(none).toEqual({ file: "claude", args: [] });
});

test("findBin tries an exact name with an extension before appending PATHEXT", () => {
  // Only the exact file exists — no `foo.exe`/`foo.cmd` variants beside it.
  const isFile = fakeFs(["C:\\tools\\my.tool"]);
  expect(norm(findBin("my.tool", { env: { Path: DIRS.join(";") }, platform: "win32", isFile }) ?? "")).toBe("c:\\tools\\my.tool");
});

test("a name that resolves to a .cmd shim cannot carry CR/LF args", () => {
  const isFile = fakeFs(["C:\\tools\\claude.cmd"]);
  for (const bad of ["fix the\r\nbug", "line\nbreak"]) {
    expect(() => resolveWindowsSpawn("claude", [bad], { Path: DIRS.join(";") }, { platform: "win32", isFile })).toThrow(/CR\/LF/);
  }
  // But an .exe hit takes the same argv untouched (CreateProcess carries it fine).
  const exe = fakeFs(["C:\\tools\\claude.exe"]);
  const r = resolveWindowsSpawn("claude", ["fix the\r\nbug"], { Path: DIRS.join(";") }, { platform: "win32", isFile: exe });
  expect(r.args).toEqual(["fix the\r\nbug"]);
});

test("arguments with spaces and quotes are quoted for the command line", () => {
  const isFile = fakeFs(["C:\\tools\\claude.cmd"]);
  const r = resolveWindowsSpawn("claude", ["--prompt", "two words", 'say "hi"'], { Path: DIRS.join(";") }, { platform: "win32", isFile });
  const line = norm(r.args as string);
  expect(line).toContain('--prompt "two words"');
  expect(line).toContain('"say \\"hi\\""');
});

test("an unknown bare name passes through so node-pty's ENOENT path still works", () => {
  const r = resolveWindowsSpawn("not-installed", ["--x"], { Path: "C:\\bin" }, { platform: "win32", isFile: () => false });
  expect(r).toEqual({ file: "not-installed", args: ["--x"] });
});
