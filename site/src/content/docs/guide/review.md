---
title: Review changes
description: Watch an agent's edits in the Code tile and send it line comments.
---

The Code tile shows what changed in a frame's folder. Comment on a line and the comment goes to
the agent as its next prompt.

1. Open the Code tile beside the agent (`3`) and switch it to **Changes**.
2. Review each file's diff as edits land.
3. Leave a comment on a line. The agent receives it as *Review comment on src/x.ts:42 …*, and fixes
   it.

Comments are kept in `.hivemind/review.json`, so these commands work with or without the app:

```bash
hive review list --status open
hive review show <id>
hive review reply <id> "fixed in 3f2c1a"
hive review resolve <id> --summary "how it was fixed"
hive review reopen <id>
hive review watch --timeout 300     # wait for the next comment
```

For a plan rather than a diff, an agent can ask you to approve it:
`hive ctl open-review --file plan.md` opens a review tile and waits for your decision.
