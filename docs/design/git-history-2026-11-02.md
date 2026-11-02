# Git history — design (2026-11-02)

Status: proposal. Step 3 of `code-tools-2026-11-02.md`. Inputs: how IntelliJ, Zed and git itself
make history fast (§3, read from their sources), measurements on two repositories (§4), and the
app's git adapter (`packages/host/src/git-adapter.ts`), which has status, diff, stage, commit,
push and pull, and no log or blame.

## 1. Who it is for, and the job

Developers who watch agents change code. Three questions, each answered in a moment:

- **What did the agents commit?** The log: commits, their files, their diffs.
- **What happened to this file?** Its history, through renames.
- **Who wrote this line, and why?** Blame beside the editor's lines, the commit a click away.

## 2. What it must feel like

- The first screen of any of the three is drawn in under 100 ms on a repository of 80,000
  commits, and nothing the person does waits on the rest.
- Typing in the editor, scrolling a list or a file changing on disk starts no git process.
- An answer no longer wanted (the person scrolled past it, closed the tab) stops its git process.

## 3. What the fast ones do

| Who | What they do | Source |
|---|---|---|
| IntelliJ, the log | Loads a **first block** (`--max-count` twice what is shown, no `--tags`, which it found slow with many tags), then **all hashes** with `--date-order` in the background, then **metadata only for the hashes on screen** (`readMetadata`) and full details (messages, files) on demand (`readFullDetails`). Sorts in its own code (`VcsLogSorter`). | `plugins/git4idea/backend/src/log/GitLogProvider.kt` |
| IntelliJ, the index | A persistent index (`VcsLogPersistentIndex`, paths, renames, users, messages) filled in the background at the lowest priority in batches of 20,000, so filtering by path or author does not ask git; skipped for repositories it marks big; a rebuildable cache. | `platform/vcs-log/impl/…/data/index/VcsLogPersistentIndex.java` |
| IntelliJ, file history | Streams `git log --name-status` and follows renames itself: at the commit that added the file it asks `git show --follow --name-status` for the parent's path and carries on there. | `plugins/git4idea/backend/src/history/GitFileHistory.kt` |
| Zed, blame | One `git blame --incremental` per request, parsed as it streams (yielding every 512 lines); unsaved text passed with `--contents -` on stdin; commit messages for all the blamed commits in **one** batched call; the process killed when the request is dropped. | `crates/git/src/blame.rs` |
| git | **Changed-path Bloom filters** in the commit-graph (`git commit-graph write --changed-paths`): `git log -- <path>` skips commits that cannot have touched the path. Reported 2–5× on git and Linux. | git `bloom.c`; [gitgitgadget/git#497](https://github.com/gitgitgadget/git/pull/497) |
| gitoxide (Rust) | Reported faster than git at `log` (1.16× on git's repository, 1.88× on Linux) and up to 30% slower at blame with commit-graph caches; an experimental blame cache took one blame from ~300 ms to ~4 ms. | [cruessler/gix-benchmarks](https://github.com/cruessler/gix-benchmarks), [gitoxide discussion #1855](https://github.com/GitoxideLabs/gitoxide/discussions/1855) |

## 4. Measured here

git 2.43, a 4-CPU cloud container, best of 3 runs. The hivemind repository (1,532 commits) and
git's own (82,668 commits; a 638-commit history for `builtin/log.c`, a 7,860-line `diff.c`).

| | hivemind | git | git + commit-graph with Bloom filters |
|---|---|---|---|
| First 200 commits, current branch, git's order | | **6 ms** | |
| First 200 commits, all branches, `--date-order` | 28 ms | 929 ms | 140 ms |
| All commits' hash, parents and time (the graph) | 31 ms | 966 ms | 992 ms |
| A file's whole history | 33 ms | 695 ms | **164 ms** |
| A file's first 100 history entries | | 81 ms | **28 ms** |
| A file's history with `--follow --name-status` | 52 ms | 2,024 ms | 1,243 ms |
| Blame, whole file (`--incremental`) | 50 ms | 1,400 ms | 988 ms |
| Blame, the first screen (`-L 1,80`) | | | 458 ms |
| Blame with `-w -M` (moved lines) | 147 ms (3× plain) | | |
| Full messages of 50 commits (`log --no-walk`) | | 6 ms | |
| One commit's files (`show --name-status`) | 3 ms | 8 ms | |
| Writing the commit-graph with Bloom filters | | 7.8 s once; 5.8 MB | |

gitoxide was not measured: building it here was refused, as running code from crates.io.

## 5. Decisions

### 5.1 First screen first

Every list asks for one screen, then the rest. The log's first block is the current branch in
git's own order (`git log -n 200`, 6 ms at 82,668 commits) and shows at once; the other branches
and the date order follow in the background (140 ms with the commit-graph), merged in as they
arrive, as IntelliJ does. Metadata is read for the rows on screen; a commit's message and files
when it is opened. A file's history asks for 100 entries (28 ms), then pages. Blame asks for the
lines in sight with `-L` and then the whole file.

### 5.2 Keep git's commit-graph, with Bloom filters

The largest win here costs no new code: 4.2× on a file's history, 6.6× on the log's date-ordered
first block, 1.4× on blame. The host writes it once per repository, in the background at the
lowest priority (`nice`), the first time History or Blame is used there:

`git commit-graph write --reachable --changed-paths --split`

and keeps it current with `--split` (incremental) after a commit, pull or fetch the app makes.
Skipped for a shallow clone. git already writes a commit-graph during `gc` by default
(`gc.writeCommitGraph`, since 2.24); this adds the Bloom filters and writes it sooner. A setting,
on by default, turns it off (`code.commitGraph`), and the guide says what it writes and where
(`.git/objects/info/commit-graphs/`).

### 5.3 Stream, page, and stop what is not wanted

Answers come in pages (`cursor`), each a single bounded git process, so the API needs no stream.
A page parses git's output as it arrives. A request superseded (the next page asked before this
one ended, the tab closed) kills its process. At most two history processes run per repository;
what is on screen goes first.

### 5.4 Cheap by default, costly on request

- No `-M`/`-C` in blame (3× here); a **Detect moved lines** switch turns them on.
- No `--follow` on the first pass (1,243 ms against 164 ms). When a file's history reaches the
  commit that added it, one `git show --follow --name-status <commit> -- <path>` says whether it
  was renamed there, and the history carries on under the old path, as IntelliJ does.
- Messages of the commits on screen in one `git log --no-walk` (6 ms for 50), as Zed batches them.

### 5.5 Cache by identity, clear on change

Keyed by what decides the answer, so the same question is never asked twice:

| Answer | Key | Cleared when |
|---|---|---|
| Log page | repo, the refs' oids, page | a ref moves |
| File history page | repo, `HEAD` oid, path, page | `HEAD` moves |
| Blame of a committed file | repo, `HEAD` oid, path, range | `HEAD` moves |
| Blame of the working file | repo, path, its size and mtime | the file is written |
| A commit's message and files | oid | never: a commit does not change |

At most 64 entries per repository, least recently used out. A file write drops only the entries
for the paths it names; nothing is recomputed until it is asked for again. An unsaved edit is
not blamed until it is saved; **Blame unsaved text** (`--contents -`) is a click, not a keystroke.

### 5.6 Native (Rust) where it pays

git is already native, and on what this needs it is fast with the commit-graph: 6–164 ms for
first screens. gitoxide is reported faster at walking the log and slower at blame (§3) and would
be one more native binary per release target. Not adopted now. Revisit with numbers if the full
graph (992 ms at 82,668 commits) shows up on a path the person waits on; until then it is built in
the background behind the first block. An index like IntelliJ's waits for the same evidence: a
repository where filtering by author or message through git is measured slow.

### 5.7 Where it runs, and who can see it

In the host's git adapter, beside status and diff, so the app, `hive host`, a guest's window and
the phone page get the same answers. New workspace API methods, role `view`, as the other reads:

| Method | Answer |
|---|---|
| `git.log {repo, all?, cursor?, limit?}` | commits `{oid, parents, time, author, email, subject, refs}`, `next` |
| `git.fileHistory {repo, path, cursor?, limit?}` | entries `{oid, time, author, subject, path}` (the path it had then), `next` |
| `git.blame {repo, path, from?, to?, moved?}` | hunks `{oid, start, lines, author, time, summary}`; uncommitted lines have no oid |
| `git.commit {repo, oid}` | `{message, parents, author, committer, files: [{path, status, from?, add, del}]}` |
| `git.diff` (exists) | gains a scope `{commit: oid}`: one commit against its first parent |

Agents read history with git itself; nothing new is needed for them to. To show the person,
`hive ctl open-tool @hivemind/code/changes --state '{"tab":"history","file":"src/cart.ts"}'`.

### 5.8 What the person sees

- **Changes** gets a **History** tab: the log, newest first; a commit opens its files and diffs in
  the diff surface Changes already has (`DiffSurface`).
- **History of a file**, from the editor's tab menu and from Files: the History tab filtered to
  the file, renames marked where they happen.
- **Blame** in the editor's gutter, switched on per tab: author and age on each changed run of
  lines, older lines quieter; the commit's message on hover; a click opens that commit in History.
- The commit graph's lanes, last (step 3e), drawn from the parents the log already has.

## 6. Steps

1. **3a, the host**: the methods of §5.7 in the git adapter, pages and cancellation, the cache, the
   commit-graph upkeep and its setting; unit tests against fixture repositories (a rename, a merge,
   uncommitted lines); the §4 table measured again through the API on git's repository.
2. **3b, History in Changes**: the log and a commit's diffs; e2e.
3. **3c, a file's history** from the editor and Files, renames followed; e2e.
4. **3d, Blame** in the editor gutter; e2e.
5. **3e, the graph's lanes.**

Each with its guide page, CHANGELOG line and tests (`.claude/skills/feature-done`).

## 7. Open question

- Writing the commit-graph into the person's `.git` by default (§5.2). It is what git's own `gc`
  writes, plus the Bloom filters, and it is what makes history fast on a large repository.
  Proposed: on, with the setting to turn it off and the guide saying so.
