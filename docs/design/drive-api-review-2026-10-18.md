# Drive API: what is left, and what was wrong (2026-10-18)

Status: accepted 2026-10-18. Follows [`drive-api-2026-10-09.md`](drive-api-2026-10-09.md) (D1–D8)
and Kenil's issues #85–#88.

## Verdict

D1–D8 hold. Five defects of the kind fixed in #123 (a token's 25-day timer), one of them a
security hole: the app and `hive host` each keep their own grants, so a grant taken back in
Settings still drives. Three issues need small API additions, not new systems. #87 is built
(D8); a service's grant could outlive the app that made it.

## Where each issue stands

| Issue | Built | Left |
|---|---|---|
| #85 session and transcript | `session` in `agent.list`; `agent.conversation`, `agent.tool`, `agent.sessions`, `agent.start {resume}` | the transcript file, for a program on this machine |
| #86 approvals | waits in `agent.list` (`waiting.approval`), `agent.event` `waiting`/`answered`, `agent.answer` | the full tool input: the list has a summary cut to 300 characters (an Edit shows only its file) |
| #87 sidecars | D8: a tool plugin's `service`, its own grant, restarts 1 s → 60 s, log on its page | its grant is taken back only when the same plugin starts again |
| #88 startup screens | `says` on detect rules; Claude's trust and settings-error screens | the bypass-permissions warning, and the settings warning ("values listed above were skipped") |

## Defects found

| # | Defect | Where | Effect |
|---|---|---|---|
| 1 | App and `hive host` each hold `grants.json` in memory and write it whole | `grants.ts` | with the host serving `drive.sock`: a grant made in Settings is refused, one taken back keeps driving and is written back |
| 2 | A service's grant has no end but the next start of its plugin | `services.ts` | app killed, plugin then switched off: its token holds for ever |
| 3 | `drive.sock` writes ignore backpressure | `drive.ts`, `peers.ts` | a program that stops reading grows the app's memory without bound |
| 4 | `agent.read {timeoutMs}` above 2³¹−1 ms | `control-api.ts` | answers at once, "still working" |
| 5 | The hello deadline half-closes the socket | `drive.ts` | under Node a hello after 10 s is still served; idle sockets are never freed |
| 6 | The agent feed's `seq` starts at 0 in each process | `agent-feed.ts` | after a restart, `agent.since(old)` answers changes that are not the ones after `old` |
| 7 | One spawn limit (16 a minute) for everyone | `control/plane.ts` | one looping program stops the person starting agents; refused calls use a slot |
| 8 | A service's log write throws in a stream callback; `used()` writes `grants.json` on every connection | `services.ts`, `grants.ts` | disk full crashes the app; `hive ctl` writes the file once per command |

Ruled out (read end to end): revocation racing a call (all synchronous; a call in flight
finishes), `/repo-evil` beside `/repo` (`inWorkspace` needs a separator), symlinked worktrees,
a grant with the owner role (`ROLES` has none), the waits' maps (capped or cleared), the Windows
pipe (the token is the check).

## What others do

| Source | Lesson here |
|---|---|
| [Claude Code hooks](https://code.claude.com/docs/en/hooks): `PreToolUse` gets `tool_input` whole, and `transcript_path` | the hook already hands over the full input; keep it, do not re-read it |
| [Codex app-server](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v1.rs): approval params carry the full `command` and every file change | an approver sees what it approves, not a summary |
| [ACP tool calls](https://agentclientprotocol.com/protocol/tool-calls): the permission request names the tool call; details come by `session/update` | a request can point at the detail, fetched apart from the notice |
| [Redis `client-output-buffer-limit`](https://raw.githubusercontent.com/redis/redis/unstable/redis.conf): pub/sub clients cut at 32 MB | a push stream caps each client's buffer and closes it |
| [Kubernetes watch](https://kubernetes.io/docs/reference/using-api/api-concepts/): too old → 410 Gone → list again | a bounded replay, and a cursor from another life must say "list again" |
| [Kubernetes bound tokens](https://kubernetes.io/docs/reference/access-authn-authz/service-accounts-admin/) | a sidecar's token belongs to its process's life, handed by the supervisor |
| [systemd `RestartSteps`](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html), [VS Code extension host](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/extensions/common/abstractExtensionService.ts) (3 crashes in 5 min, then a button) | D8's backoff matches systemd; a give-up is the upgrade if a crash loop costs anything |
| [GitHub fine-grained tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens): named, per repository, expiry | what grants already are |
| [Docker daemon security](https://docs.docker.com/engine/security/) | the socket's owner is the user; a grant is accounting and a brake on a talked-into model, not a wall |

## Choices

### Full input of an approval (#86)

```
A  in the list         hook ─input─► wait ─► agent.list / agent.changed ─► every client, each change
B  by its tool use     hook ─tool_use_id─► wait ;  client ─agent.tool(tile, use)─► session file
C  asked for           hook ─input─► wait ;  client ─agent.approval(tile)─► wait.input
```

| | today: 10 agents, 5 clients, ~50 approvals a day | 10x | 100x | first breaks |
|---|---|---|---|---|
| A | 50 × 3 changes × 5 clients × 256 KB worst = 192 MB a day pushed | 1.9 GB | 19 GB, to phones too | a phone's link, every change of a waiting agent |
| B | 0 pushed; one file read a look | same | same | agents with no transcript mapping, or whose hook fires before the record is written |
| C | 0 pushed; ≤ 256 KB per look | same | same | memory: 1,000 waits × 256 KB = 256 MB held |

A: bytes per wait (3 `agent.changed` while it waits) × clients. C's memory is waits held at once,
each its input as the hook sent it (≤ 1 MiB line, kept ≤ 256 KB).

**C.** A pushes the largest field to every device for every change. B depends on each agent's
session file. C serves what the hook already gave, for any agent with a broker hook.
`agent.approval(tile)` answers the supervised tool use it waits on, `input` whole up to
262,144 characters as `agent.tool` cuts. The list keeps its summary.

### The transcript (#85)

| | What | For | Against |
|---|---|---|---|
| A | nothing new: `session` + `agent.conversation` + `agent.tool` | one format for every agent and machine | a program wanting the agent's own records has none |
| B | `transcript` in every `agent.list` item | what the issue asks | a guest or phone is handed this machine's paths (D6's reason); a remote machine's path means nothing here |
| C | `agent.transcript(tile)` → `{session, path}`, to a caller on this machine, for an agent on this machine | the path where it is true; nothing pushed | one more method |

**C.** D6 refused B for a guest; that reason does not hold for a program on the same machine, which
Claude's own hooks hand `transcript_path` to. An agent on a remote machine or a caller over
hive-net is `UNSUPPORTED`. The path is found as `agent.conversation` finds the file.

### One spawn limit, or one each

| | Today (16/min) | A looping program |
|---|---|---|
| one for all | 1,000 spawns ≈ 63 min | locks out the person and every agent |
| one per caller (person, each grant, each agent) | same for one caller | locks out itself |

**One each.** A slot is taken only by a call that passes its checks.

### The rest have one answer

| Item | Design |
|---|---|
| #1, #2 grants | one owner, below |
| #3 slow reader | a connection whose unsent bytes pass 16 MiB is closed with `{"error": {"code": "TOO_SLOW"}}` written first when there is room |
| #4, #5 | timeouts capped at 2³¹−1 ms; the hello deadline destroys the socket |
| #6 | `seq` starts at the clock (ms), so a cursor from an earlier process is below the oldest kept: `null`, list again |
| #8 | log and grant writes caught; `lastUsed` written at most once a minute |
| #88 | rules from claude 2.1.302: the bypass warning (`says: bypass`, text read from the binary) and the settings warning (`says: settings-warning`, rendered: `1` continues, `3` exits). The bypass warning gets no answer keys: accepting it is the person's consent, typed at the terminal |

## Who owns grants (first principles)

| | |
|---|---|
| Goal | A token taken back anywhere stops working everywhere at once. |
| Done when | With `hive host` serving and the app open, a grant made in Settings drives at once, and one taken back there closes its program's connection and lets nothing in. |

| Assumption | Kind | Evidence |
|---|---|---|
| Two processes may run on one machine, the app opened after `hive host` | fact | `hive host run` refuses beside the app (#102), but nothing stops the app beside a running host; `serveDrive` says "whichever came first serves" |
| Only one serves `drive.sock` | fact | `listenExclusive` (`socket-claim.ts`) |
| Services run only where `drive.sock` is served | fact | `startServices` and `headless.ts` wait for `serving` (D8) |
| Each process that may serve keeps its own grants | habit | both build `new Grants` since D1 (61e4d4f); no reason recorded |
| Settings answers `grant.*` from its own process | habit | `grantsDomain(() => grants())` in `index.ts`, the same since D1 |

| Design | Owner | Lost because |
|---|---|---|
| A. the file is the truth, both read it when it changes, watched every 2 s | none: two | two writers race read-change-write; a revoke reaches the other process up to 2 s late |
| B. **the process serving `drive.sock` owns grants and services; the other's Settings asks it over `drive.sock`, as the person** | one | — |
| C. the app refuses to open beside a running host | one | stops the person's app because a service is running; a larger change of who serves workspaces |

B: `grantsDomain` answers from the owner: its own grants when it serves, else a call on `drive.sock`
with the install's token. A service grant found when a process begins serving was left behind by
the one before (services run only where it is served), so it is taken back then. Ceiling: when the
host stops, the app does not take `drive.sock` over until it starts again (as today).

## Dropped (confirmed by the maintainer, 2026-10-18)

| Choice or habit | From | Why it no longer holds |
|---|---|---|
| Each process that may serve `drive.sock` keeps grants | D1 (61e4d4f), habit | two owners of one file: a revoke in Settings did not reach the host |
| A service's leftover grant is taken back when its own plugin starts again | D8 | a plugin switched off never starts again: its token held for ever |
| One spawn limit for every caller | the control plane (cb4273c), made when only agents spawned | programs share it now; one loop locks out the person |
| No transcript path anywhere (`agent.conversation` only) | D6 | its reason (a guest or phone gets this machine's paths) does not hold for a program on this machine |
| The agent feed's `seq` counts from 0 in each process | habit | a cursor from the process before reads as current |

## Pre-mortem

| A year on, it failed because | Changed |
|---|---|
| The app's Settings showed grants while nothing served `drive.sock` | `grant.*` from a process that does not serve answers `UNAVAILABLE`, naming who should |
| Claude reworded its bypass warning and workers stalled unnamed again | the rule matches two literals from the binary; the fixture test names the version; the golden fails on a manifest change |
| An approval's input carried a secret to a `view` grant | `agent.approval` takes the role `agent.tool` takes; the audit names who read it |

Ceilings: 16 MiB × stalled connections (100 = 1.6 GB); a service restarts once a minute for ever
while it fails (VS Code's 3-in-5-minutes give-up is the upgrade); 1,000 agent changes replayed.

## Build order (one PR, a commit each)

| # | PR | Checked by |
|---|---|---|
| 1 | this document | — |
| 2 | one owner of grants, the process serving `drive.sock`; service grants left behind taken back (#87) | host serving, app's Settings makes and takes back a grant: it drives, then is closed out |
| 3 | drive socket limits: slow reader, hello deadline, `agent.read` timeout, feed `seq`, log/grant writes | a client that never reads is closed; a 3e9 ms read waits; a restarted feed answers `null` |
| 4 | a spawn limit per caller | one caller at its limit, another still starts |
| 5 | Claude's bypass and settings-warning screens (#88), with the plugins repo's manifest | screens from 2.1.302 read as `bypass` and `settings-warning` |
| 6 | `agent.approval` (#86) | a supervised Edit's whole `new_string` is answered |
| 7 | `agent.transcript` (#85) | its path is the session's file; a guest is `UNSUPPORTED` |

## Unknown

- The bypass warning's rendered layout: launching `claude --dangerously-skip-permissions` was not
  possible here, so its rule matches only text read from the 2.1.302 binary. Check: start a
  worker in its unattended mode on a machine that never accepted it.
- Whether Claude writes a tool use's record before `PreToolUse` fires (it decides B above, not C).
