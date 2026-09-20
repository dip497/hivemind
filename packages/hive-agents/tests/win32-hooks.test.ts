/**
 * The Windows hook-command form, asserted from any host: `platform` is injected into the
 * render request, so bun on Linux renders and checks exactly what a Windows daemon will
 * run. The POSIX form is pinned in the same breath — the provider golden depends on it
 * never moving.
 */
import { expect, test } from "bun:test";
import { hookCommand } from "../src/hooks.js";
import type { LaunchRequest } from "../src/runtime.js";

const req = (over: Partial<LaunchRequest> = {}): LaunchRequest => ({
  tileId: "tile-1", cwd: "C:\\repo", args: [], env: {}, phase: "spawn", platform: "win32",
  paths: {
    private: "C:\\ud", execPath: "C:\\app\\hivemind.exe", hooks: {}, tileSessionsDir: "C:\\ud\\ts",
    home: "C:\\Users\\u",
  },
  ...over,
});
const hook = { path: "C:\\ud\\hcp-stop-hook.cjs" };

/** Split a rendered command into the powershell path and the decoded script body. */
function decode(cmd: string): { exe: string; script: string } {
  const m = /^(.*powershell\.exe) -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(cmd);
  expect(m, `not a win32 encoded command: ${cmd}`).toBeTruthy();
  return { exe: m![1]!, script: Buffer.from(m![2]!, "base64").toString("utf16le") };
}

test("win32: the command decodes back to the script, with env vars and quoted paths", () => {
  const cmd = hookCommand("approval", hook, req({ supervise: "all" }));
  const { script } = decode(cmd);
  expect(script).toBe(
    "$ProgressPreference='SilentlyContinue'"
    + "; $env:HIVEMIND_TILE='tile-1'; $env:HIVE_SUPERVISE='all'; $env:ELECTRON_RUN_AS_NODE='1'"
    + "; $s=New-Object System.Diagnostics.ProcessStartInfo; $s.FileName='C:\\app\\hivemind.exe'"
    + "; $s.Arguments='\"C:\\ud\\hcp-stop-hook.cjs\"'; $s.UseShellExecute=$false"
    + "; $p=[System.Diagnostics.Process]::Start($s); $p.WaitForExit(); exit $p.ExitCode",
  );
  // A hook argument lands quoted after the script path, in the same escaping.
  const withArg = decode(hookCommand("stop", { path: hook.path, arg: "C:\\ud\\hcp.sock" }, req()));
  expect(withArg.script).toBe(
    "$ProgressPreference='SilentlyContinue'"
    + "; $env:HIVEMIND_TILE='tile-1'; $env:ELECTRON_RUN_AS_NODE='1'"
    + "; $s=New-Object System.Diagnostics.ProcessStartInfo; $s.FileName='C:\\app\\hivemind.exe'"
    + "; $s.Arguments='\"C:\\ud\\hcp-stop-hook.cjs\" \"C:\\ud\\hcp.sock\"'; $s.UseShellExecute=$false"
    + "; $p=[System.Diagnostics.Process]::Start($s); $p.WaitForExit(); exit $p.ExitCode",
  );
});

test("win32: a single quote in a path is doubled, not broken out of", () => {
  const { script } = decode(hookCommand("stop", hook, req({ paths: { ...req().paths, execPath: "C:\\app\\o'brien.exe" } })));
  expect(script).toContain("$s.FileName='C:\\app\\o''brien.exe'");
});

test("win32: the rendered line is bare of quoting metacharacters outside the powershell path", () => {
  const cmd = hookCommand("stop", { path: hook.path, arg: "C:\\ud\\hcp.sock" }, req());
  const exe = cmd.slice(0, cmd.indexOf(" -NoProfile "));
  const tail = cmd.slice(cmd.indexOf(" -NoProfile "));
  // The path itself must carry no backslash (the forward slashes are the point), and
  // everything after it is bare base64 over flags: no quotes, no `$`, no backslash.
  expect(exe).not.toContain("\\");
  expect(/['"$\\]/.test(tail)).toBe(false);
});

test("win32: SystemRoot comes from the render env, or falls back to C:/Windows", () => {
  expect(decode(hookCommand("stop", hook, req())).exe).toBe("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe");
  const withRoot = decode(hookCommand("stop", hook, req({ env: { SystemRoot: "C:\\WINDOWS" } })));
  expect(withRoot.exe).toBe("C:/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe");
});

test("posix: the form is unchanged — env-prefixed, single-quoted, ELECTRON_RUN_AS_NODE first-class", () => {
  const cmd = hookCommand("approval", { path: "/ud/hook.cjs", arg: "/ud/s.sock" }, req({
    platform: "linux", supervise: "all",
    paths: { ...req().paths, execPath: "/x/electron", hooks: {} },
  }));
  expect(cmd).toBe("HIVEMIND_TILE='tile-1' HIVE_SUPERVISE='all' ELECTRON_RUN_AS_NODE=1 '/x/electron' '/ud/hook.cjs' '/ud/s.sock'");
});
