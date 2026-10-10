# Agent backlog

Pains seen in sessions that were real but not yet worth fixing. Seen again: build it.

- 2026-10-10 — CLI tests are not typechecked (`apps/cli` typecheck skips `tests/`): a test kept
  `serveDrive`'s removed `holds` option, and the call hung instead of failing to compile. Fix:
  include `tests/` in the CLI's typecheck; size the existing errors first.
