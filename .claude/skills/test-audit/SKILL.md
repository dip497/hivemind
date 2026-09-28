---
name: test-audit
description: Use whenever writing, changing or reviewing a test in hivemind. The authoring gate every new or changed test must pass, the junk patterns it rejects, what makes an existing test worth keeping, and how to prove a test can fail. Adapted from openclaw's test-audit skill at the maintainer's request.
---

# Test audit

The maintainer's rule: every test written or changed here passes this gate. It is adapted
from [openclaw's `test-audit` skill](https://github.com/openclaw/openclaw/blob/d5b11b54afc049b6348b3788ff5e1e3278bc6995/.agents/skills/test-audit/SKILL.md)
(MIT, © 2026 OpenClaw Foundation): the gate, the junk patterns and the retention bar are
theirs, and the commands and examples are ours.

## Authoring gate

Before adding or changing a test, answer four questions. A missing answer means the test
does not go in yet.

1. What observable behaviour, invariant or independent contract does it protect?
2. What credible regression makes it fail?
3. Why does existing coverage not already catch that? Each contract has one owner test at the
   strongest boundary. Another layer needs its own distinct risk, such as a transport,
   lifecycle or wiring failure the owner cannot reach. Prefer a new row in a table-driven test,
   or a shared fixture, over a near-duplicate test.
4. Does it need a production seam (an export, option, flag, clock, hook) that no production
   caller needs? Then test at the real boundary and do not add the seam.

A test that would break under a behaviour-preserving refactor is asserting implementation.
Rewrite it at the owning boundary before it lands.

## Junk patterns

A match fails the gate unless the retention bar below names the contract it guards.

- assertion-free coverage probes; self-comparisons;
- copied fixtures, inventories, manifests or export lists;
- exact source, import or string greps;
- call-shape tests (call counts, "called with") of private helpers that real boundaries cover;
- the same contract asserted again in another test or at another layer;
- tests that exist to keep a test-only export, global or wrapper alive, and production code
  whose only callers are tests;
- expected values produced by the code under test (building the expected storage key with
  the key builder that the code also uses);
- mocks that implement the asserted behaviour; one mock standing in for different APIs;
- fixtures that supply what the code should produce; persistence asserted against a store
  the code never writes;
- negative controls that pass for an unrelated reason ("a corrupt blob starts fresh" planted
  under a key the code never reads passes whatever the code does);
- names that promise more than the test exercises.

## Retention bar

Keep a test that independently enforces a public API, protocol, config, migration, storage,
security, platform, default, package or release contract. Also keep call order when the order
is observable, and a regression with a credible failure mode. Spelling out a literal is right
when the literal is the contract: the localStorage keys earlier versions wrote, a file name on
users' disks, a CLI flag. Static or slow is not a reason to delete a test.

## Prove it can fail

A test that has never failed proves nothing. For each new test, make one small edit to the
production code that breaks what the test guards, run the test, see it fail for the reason it
names, then restore the code. A bug's regression test must fail on the code before the fix.
Note the mutations that matter in the commit message or the tracker.

## Changing an existing test

Hold the lines you touch to the same gate. Deleting a test needs evidence: what it can
detect, which stronger test still covers that, and why it was added (`git log -S`).

## Checks

- A package: `pnpm -F <package> test`, then `pnpm typecheck` from the root.
- Desktop units: `pnpm -F @hivemind/desktop test:unit` (`tsx --test`).
- e2e: `apps/desktop/AGENTS.md`. Rebuild with `pnpm exec electron-vite build` in
  `apps/desktop` before running a spec against changed source.
- `git diff --check` before committing.
