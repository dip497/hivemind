// workspace-paths: the picked-dir → (root, repoPath) resolution. The bug this
// guards: `.hivemind` in a PARENT folder + a picked CHILD repo must bind to the
// CHILD (repoPath = child git root), not collapse up to the umbrella folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findGitRoot, computeRepoPath } from "../../src/main/workspace-paths.ts";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

// A tmp $HOME so findGitRoot's home-guard never trips on the real one, and an
// umbrella workspace with a nested child repo underneath it.
function scaffold(): { home: string; umbrella: string; child: string; childRepo: string } {
  const home = mkdtempSync(path.join(tmpdir(), "hm-home-"));
  const umbrella = path.join(home, "Workspace");
  mkdirSync(path.join(umbrella, ".hivemind", "issues"), { recursive: true });
  // A child folder that is its OWN git repo (the `snr-agentx` case).
  const childRepo = path.join(umbrella, "snr-agentx");
  mkdirSync(childRepo, { recursive: true });
  git(childRepo, "init", "-q");
  // A child folder that is NOT its own repo — just a plain subdir.
  const child = path.join(umbrella, "plain-subdir");
  mkdirSync(child, { recursive: true });
  return { home, umbrella, child, childRepo };
}

test("child repo under an umbrella .hivemind binds to the CHILD, not the parent", async () => {
  const { home, umbrella, childRepo } = scaffold();
  try {
    const gitRoot = await findGitRoot(childRepo, home);
    // The picked child IS a git repo → repoPath must be the child itself.
    assert.equal(gitRoot, childRepo);
    // root (issues) is the umbrella's .hivemind; repoPath is the child.
    const root = path.join(umbrella, ".hivemind");
    const repoPath = computeRepoPath(root, gitRoot);
    assert.equal(repoPath, childRepo, "must bind to the picked child repo");
    assert.notEqual(repoPath, umbrella, "must NOT collapse up to the umbrella folder");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("plain subdir (no own .git) under umbrella repo binds to the umbrella git root", async () => {
  const { home, umbrella, child } = scaffold();
  // Make the umbrella itself a git repo so the plain subdir has an ancestor repo.
  git(umbrella, "init", "-q");
  try {
    const gitRoot = await findGitRoot(child, home);
    assert.equal(gitRoot, umbrella, "walks up to the umbrella git root");
    const root = path.join(umbrella, ".hivemind");
    assert.equal(computeRepoPath(root, gitRoot), umbrella);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("no git repo but a .hivemind exists → falls back to dirname(root)", () => {
  const root = "/some/where/Workspace/.hivemind";
  assert.equal(computeRepoPath(root, null), "/some/where/Workspace");
});

test("no git repo and no .hivemind → null (empty playground)", () => {
  assert.equal(computeRepoPath(null, null), null);
});

test("findGitRoot stops at $HOME (no dotfiles-repo hijack)", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "hm-home2-"));
  try {
    git(home, "init", "-q"); // a repo AT $HOME
    const sub = path.join(home, "proj");
    mkdirSync(sub);
    // Walking up from a subdir must NOT return $HOME.
    assert.equal(await findGitRoot(sub, home), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
