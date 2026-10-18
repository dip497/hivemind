Plugins the e2e suite runs against: the host is what is under test, so these stay fixed.

- `views/`: views. Built ones are copies of a `views/<name>/dist` from the plugins repository
  (dip497/hivemind-plugins), with the id unscoped; `agent-board` is a copy of its plain view.
- `widgets/progress`: a copy of the Progress widget from the plugins repository, as `@example/progress`.
- `tools/commits`: a small tool written for these tests, using each part of the tool API.
