// git on a Windows machine, as its ssh runs what the Code tile sends: the command line PowerShell
// takes, run here by PowerShell 7 (`pwsh`) on a real repository. What git prints arrives byte for
// byte, as git run here prints it. Skips where no `pwsh` is installed.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { remoteGit } from "../src/remote/exec.ts";

const pwsh = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status === 0;
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "hrgit-win-"));
after(() => fs.rmSync(repo, { recursive: true, force: true }));

/** `args` through the Windows command line: its git's output, error and exit code. */
function overSsh(args: string[]): { out: Buffer; err: string; code: number | null } {
  const [program, ...flags] = remoteGit(repo, args, true).split(" ");
  assert.equal(program, "powershell");
  const r = spawnSync("pwsh", flags);
  return { out: r.stdout, err: r.stderr.toString("utf8"), code: r.status };
}
const here = (args: string[]) => execFileSync("git", ["-C", repo, ...args]);

test("what git prints on a Windows machine reaches the Code tile byte for byte, each argument as given", { skip: !pwsh }, () => {
  const g = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  g("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "naïve file.txt"), "line one\r\nline two\n\u0000binary-ish\n");
  fs.writeFileSync(path.join(repo, "plain.md"), "# hi\n");
  fs.writeFileSync(path.join(repo, "it’s ‘q’; Write-Error x.txt"), "kept\n");
  g("add", "-A");
  // A typographic quote is one to PowerShell too: it never ends the word to run what follows.
  const message = `say "hi" \\ to C:\\work\\ and it's $(not run); it’s ‘done’ ‚or‛; Write-Error x`;
  g("commit", "-q", "-m", message);
  fs.writeFileSync(path.join(repo, "plain.md"), "# hi there\n");

  for (const args of [
    ["status", "--porcelain=v2", "-z"],
    ["show", "HEAD:naïve file.txt"],
    ["diff"],
    ["log", "-1", "--format=%s"],
    ["show", "HEAD:it’s ‘q’; Write-Error x.txt"],
    ["log", "-1", "--format=%s", "--fixed-strings", "--grep=it’s ‘done’ ‚or‛; Write-Error x"],
  ]) {
    const r = overSsh(args);
    assert.equal(r.code, 0, `${args.join(" ")}: ${r.err}`);
    assert.equal(r.err, "", args.join(" "));
    assert.deepEqual(r.out, here(args), args.join(" "));
  }
  assert.equal(overSsh(["log", "-1", "--format=%s"]).out.toString("utf8").trim(), message);

  const failed = overSsh(["rev-parse", "--verify", "no-such-branch"]);
  assert.notEqual(failed.code, 0);
  assert.match(failed.err, /no-such-branch|Needed a single revision/);
});
