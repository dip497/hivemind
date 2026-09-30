# Workspace API (0.1)

What a workspace's host is asked for, and what it answers. The host is the machine the
workspace's repo is on; today its callers are the app's windows and the dev-bridge, and later a
peer or another device. Every transport carries the same messages. Design: R8 in
`docs/design/multiplayer-2026-09-28.md`.

## Messages

A call is `{"method", "params"}`: `method` a dotted name (`git.stage`), `params` a list, in the
order the method below takes them. A param that is left out is `null` or absent from the end.

An answer is `{"result"}` or `{"error": {"code", "message"}}`, and nothing else: a host answers
every call, and a method that returns nothing answers `{"result": null}`. `code` is one of:

| Code | Why |
|---|---|
| `BAD_REQUEST` | The params are not what the method takes, or name something it may not reach (see below). It never ran. |
| `UNKNOWN_METHOD` | No such method on this host. |
| `FAILED` | It ran and failed: git refused, a file could not be written. `message` says why, ending in the system's code when there is one (`… (ENOENT)`). |

## Transports

| Transport | Caller | A call | Its answer |
|---|---|---|---|
| Electron IPC | the app's windows | `invoke("workspace", method, params)`, from the main frame of an app window (from anywhere else it is rejected) | the answer |
| HTTP | the dev-bridge's page | `POST /workspace`, body `{"method", "params"}`, header `x-hive-token` | 200 with the answer; 401 without the token |

## Who asks, and the audit log

Each call is some actor's: over both transports above, the person at the host's machine. A
method with an effect is carried out through the host's intents and recorded in its audit log
(`audit.jsonl`, one JSON line each), its verb the method's name: who asked, what it acted on
(`target`), a `detail`, and how it ended (`ok`, `error` with the code it failed with). A read is
not recorded. What someone wrote (a commit message, a file's contents) is never recorded.

## Params a host refuses

- A file is relative to the repo and stays inside it: an absolute path, or one whose `..` leaves
  the repo, is `BAD_REQUEST`. In an `ssh://` repo a file is a POSIX path with no `..` at all.
- A value git takes as an argument of its own — a revision (`scope.sha`, `scope.base`,
  `scope.head`), a branch, a worktree, a sparse root or an included file — may not begin with
  `-`, where git would read it as an option.
- A branch a worktree is made on is `[A-Za-z0-9._/-]+` with no `..`; its `path`, `sparse` roots
  and `includeFiles` are relative to the repo with no `..`.

## Methods

`repo` is the repo's path on the host, or an `ssh://` URI.

| Method | Params | Result | Recorded as |
|---|---|---|---|
| `git.status` | `repo` | `{branch, upstream, ahead, behind, files: [{path, status, staged, unstaged, origPath?}], conflictedFiles, isMerging, isRebasing, head}` | read |
| `git.listFiles` | `repo` | the tracked and untracked paths .gitignore leaves | read |
| `git.listBranches` | `repo` | `{current, local, remote}` | read |
| `git.diff` | `repo`, `scope`, `file`? | `{patch, cacheKey}` | read |
| `git.fileContents` | `repo`, `file`, `rev` (`HEAD` \| `INDEX` \| `WORKING`) | the text; `""` when it has none; `"\u0000HM_OVERSIZE:<bytes>"` past 1 500 000 bytes | read |
| `git.stage` | `repo`, `files` | `null` | target `repo`, detail `N files` |
| `git.unstage` | `repo`, `files` | `null` | target `repo`, detail `N files` |
| `git.discard` | `repo`, `files` | `null` (a tracked file goes back to HEAD, an untracked one is removed) | target `repo`, detail `N files` |
| `git.commit` | `repo`, `message`, `allowEmpty`? | `{sha}` | target `repo` |
| `git.push` | `repo`, `setUpstream`? | `null` | target `repo`, detail `set upstream` when asked |
| `git.pull` | `repo` | `null` (fast-forward only) | target `repo` |
| `git.conflictedFile` | `repo`, `file` | `{raw, conflicts}` | read |
| `git.writeResolved` | `repo`, `file`, `contents` | `null` | target the file |
| `worktree.list` | `repo` | `[{path, branch, head, locked, prunable, bare}]` | read |
| `worktree.create` | `repo`, `{branch, path?, sparse?, partial?, includeFiles?}` | `{path, branch}` | target `repo`, detail the branch |
| `worktree.remove` | `repo`, `worktree`, `force`? | `null` | target the worktree |
| `worktree.prune` | `repo` | `{removed}` | target `repo` |

A diff's `scope` is one of `{"kind": "working", "staged"?}`, `{"kind": "branch", "base"?,
"head"?}` (what `head`, HEAD by default, adds since it left `base`), `{"kind": "unpushed",
"base"?}` and `{"kind": "commit", "sha"}`, each with `ignoreWhitespace`?.

## Implementations

TypeScript: `packages/workspace-api` (the methods' types, a client over any transport, and the
server that answers them); the host's git and worktrees in `apps/desktop/src/main/workspace-git.ts`,
which the app's main process and the dev-bridge both serve.
