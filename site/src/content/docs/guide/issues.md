---
title: Issues
description: Track work as markdown files that you and your agents read and update.
---

Issues are markdown files in the project's `.hivemind/` folder. You, the Issues tool and agents
all change the same files, so the board updates as an agent works.

## Turn them on

Open the Issues tool (**Add ▸ Tools ▸ Issues**) in a project: it offers to keep issues there. Or:

```bash
hive init --prefix MYP            # tracker, plus agent skills and a CLAUDE.md section
hive init --prefix MYP --no-agentic   # tracker only
```

The prefix is 2 to 10 capital letters or digits, starting with a letter. Issue ids are `MYP-1`,
`MYP-2`, …

## Work with them

```bash
hive new "Fix token expiry" --ac "boundary test || manual check passes"
hive list --state todo
hive show MYP-1
hive update MYP-1 --assignee claude --assignee-type agent
hive close MYP-1                  # done; --reason "…" makes it cancelled
```

On the board, **▶ work** on an issue card starts an agent on it. The agent loads the issue, claims
it, ticks each acceptance criterion and ends by setting its state: the steps are in
[Coordinate agents](../agent-workflows/#the-steps-an-agent-follows-on-an-issue).

## States

<figure class="diagram" style="--min:600px">
  <div><img src="../../diagrams/workspaces-issue-states.svg" width="700" height="316" alt="Issue states: an issue usually moves backlog, todo, in_progress, in_review, done, and can be set to cancelled from any state. The order is not enforced: any state can be set from any other. hive close sets done, hive close --reason sets cancelled, and hive reopen sets todo." /></div>
  <figcaption>The usual track; nothing enforces it</figcaption>
</figure>

Every change is a line in the issue's activity, signed by the person or agent who made it.

## Sub-issues and links

```bash
hive task MYP-3 add "Write the test"     # MYP-3.1
hive new "…" --parent MYP-3
hive relate MYP-3 OPS-7 --type blocks    # written on both issues
hive move MYP-3 OPS                      # to another project; --copy keeps the original
```

Link types: `relates`, `blocks`, `blocked-by`, `duplicates`, `parent-of`, `child-of`. To use ids
from another project, register both: `hive workspace register`, then `hive workspace list`.

## The folder

```text
.hivemind/
├── issues/MYP-1.md   one file per issue (sub-issues in issues/MYP-1/)
├── config.yaml       prefix and next id
├── review.json       comments left on a diff
└── .agent.md         a summary of open issues for agents (not committed)
```

Every command: [CLI reference](../cli/#issues).
