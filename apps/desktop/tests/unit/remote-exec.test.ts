// remote/exec — git command builder (injection-safe) + concurrency limiter.
import { test } from "node:test";
import assert from "node:assert/strict";

const { remoteGit, ConcurrencyLimiter } = await import("../../src/main/remote/exec.ts");

test("remoteGit builds `git -C <path>` with all args single-quote escaped", () => {
  assert.equal(
    remoteGit("/srv/app", ["status", "--porcelain=v2"]),
    "git -C '/srv/app' 'status' '--porcelain=v2'",
  );
});

test("remoteGit neutralizes shell metacharacters in the path (injection guard)", () => {
  // A path trying to break out stays inside ONE single-quoted token, so the
  // command substitution is inert (present as literal text, never executed).
  const cmd = remoteGit("/srv/$(rm -rf ~)", ["log"]);
  // Exact form proves the substitution stays inside one single-quoted token.
  assert.equal(cmd, "git -C '/srv/$(rm -rf ~)' 'log'");
});

test("remoteGit escapes embedded single quotes in args", () => {
  assert.equal(
    remoteGit("/r", ["commit", "-m", "it's a fix"]),
    `git -C '/r' 'commit' '-m' 'it'\\''s a fix'`,
  );
});

test("ConcurrencyLimiter caps in-flight per key and drains the queue", async () => {
  const limiter = new ConcurrencyLimiter(2);
  let active = 0;
  let peak = 0;
  const task = async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return true;
  };
  const results = await Promise.all(
    Array.from({ length: 8 }, () => limiter.run("host", task)),
  );
  assert.equal(results.length, 8);
  assert.ok(results.every(Boolean));
  assert.ok(peak <= 2, `peak concurrency ${peak} exceeded cap 2`);
});

test("ConcurrencyLimiter isolates keys (separate hosts run independently)", async () => {
  const limiter = new ConcurrencyLimiter(1);
  let a = 0, b = 0, peakBoth = 0;
  const mk = (which: "a" | "b") => async () => {
    if (which === "a") a++; else b++;
    peakBoth = Math.max(peakBoth, a + b);
    await new Promise((r) => setTimeout(r, 5));
    if (which === "a") a--; else b--;
  };
  await Promise.all([
    limiter.run("a", mk("a")),
    limiter.run("b", mk("b")),
  ]);
  // one per key, but the two keys run concurrently → combined peak 2.
  assert.equal(peakBoth, 2);
});
