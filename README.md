<p align="center">
  <img src="assets/icon.png" alt="hivemind" width="76" />
</p>

<h1 align="center">hivemind</h1>

<p align="center"><b>A workspace for coding agents.</b><br />Run them next to the terminals, editors and diffs they are working on.</p>

<p align="center">
  <a href="https://hivemind.griiken.com/">site</a> ·
  <a href="https://hivemind.griiken.com/guide/">docs</a> ·
  <a href="https://github.com/dip497/hivemind/releases">releases</a> ·
  <a href="https://hivehub.griiken.workers.dev/">plugins</a>
</p>

> *Four agents, four terminals, four tabs.* One is waiting for approval, one finished ten
> minutes ago, one is editing a file you meant to read first — and you find out by cycling
> through windows.

hivemind puts them on one canvas per repository. Every tile is live: a terminal running an
agent, a diff that updates as that agent edits, a file tree, an editor, an issues board, a
browser. Group tiles into frames, bind a frame to a repository, a git worktree or an SSH
host, and several agents work in parallel without reaching into each other's directories.

<img width="1920" height="1200" alt="An issue board and a live diff side by side on one canvas" src="https://github.com/user-attachments/assets/8b33c851-c4fb-456b-8231-a2ddd3583dfd" />

<sub>An issue board and the live diff of a fix, side by side. The agent edits; the diff updates as you watch.</sub>

---

## Install

```bash
bash <(curl -fsSL https://hivemind.griiken.com/install.sh)
```

Linux x86_64 and macOS Apple Silicon have prebuilt releases, so you need no toolchain;
Intel macs and Linux arm64 build from source with `--dev`. Re-run it to upgrade, or pin a
version with `HIVEMIND_VERSION=v2026.9.0`. Windows builds and passes its checks in CI, but
nothing is published until it has been launched on real hardware.

## Use

```bash
cd ~/my-project
hive init --prefix MYP          # .hivemind/config.yaml + the agent skills
hive new "Fix token expiry comparison"
hivemind .
```

`1`–`7` spawn a terminal, an agent, an explorer, a diff, the issues board, a frame or a
browser. Click **Work** on an issue and the agent starts with that issue and the `hive`
skills loaded. `⌘L` opens the layers rail, `⌘E` switches view.

## What you get

| | |
|---|---|
| **Agents you already have** | no agent ships in the app: the ones whose CLI is on your machine are added from [HiveHub](https://hivehub.griiken.workers.dev/), and a notice says what each can do |
| **Status you can see** | working, finished, or waiting for you — read from the agent's own screen, so it needs no cooperation |
| **Terminals that outlive the window** | a detached daemon keeps them running and replays the screen on reopen; a session resumes after a reboot |
| **Issues as files in your repo** | markdown with YAML frontmatter under `.hivemind/`; no database, no account |
| **Agents driving the canvas** | `hive ctl` spawns a tile, sends it work, reads the reply, pipes agents together, brokers approvals — over a local `0600` socket, with no MCP server to run |
| **Views and plugins** | the canvas is one view; install another from HiveHub or write one against a sandboxed API with no files, network or app access |

Works with **Claude Code · Codex · Cursor · Droid · Kiro · pi · Gemini · opencode** and a
dozen more, on Linux and macOS.

## Bring your own agent

An agent is a manifest: a file naming the command to run and how to read that command's
screen. Yours passes exactly the checks a listed one does, so there is no privileged tier
and nothing to fork.

```bash
hive agents validate ./my-agent    # what a user will be told about it
hive agents install ./my-agent     # from a folder
hive agents install gemini         # or by name, from HiveHub
```

Adding an agent for everyone is a pull request to
[dip497/hivemind-plugins](https://github.com/dip497/hivemind-plugins). Views are yours to
publish: `hive views new <name>` writes one, `hivehub publish` lists it. See
[agents](https://hivemind.griiken.com/guide/agent-providers/) and
[views](https://hivemind.griiken.com/guide/views/).

## Development

```bash
git clone https://github.com/dip497/hivemind.git
cd hivemind && pnpm install

pnpm --filter @hivemind/desktop run dev          # the app, reloading
pnpm --filter @hivemind/cli run dev <subcommand> # the CLI
pnpm --filter @hivemind/desktop run test:unit    # node:test
pnpm --filter @hivemind/desktop run test:e2e     # playwright under xvfb
```

The renderer-only loop (`run dev:bridge -- /path/to/repo`) must run under `tsx`, not bun:
bun's loader silently drops `@lydell/node-pty` output on Linux.

Issues and pull requests are welcome — `pnpm typecheck` and the unit tests should pass
first; the e2e suite needs a quiet machine. See
[contributing](https://hivemind.griiken.com/guide/contributing/) and the
[architecture](https://hivemind.griiken.com/guide/).

---

**Ideas borrowed**, with thanks:

- [tmux](https://github.com/tmux/tmux) — detach keeps it alive. Our terminals outlive the window for the same reason.
- [tldraw](https://tldraw.com) and Figma — a frame is a place, not a rectangle: bind one to a repo and everything inside inherits it.
- [Plane](https://plane.so) — issues, cycles and acceptance criteria worth keeping, here as files in your own repo.
- [Pierre](https://pierre.co) — a diff that belongs in the workspace rather than a browser tab.
- [npm](https://docs.npmjs.com/cli/using-npm/scope) — `@owner/name` scopes, so two people's `board` never collide, and the scope is the owner.
- [VS Code](https://code.visualstudio.com/api) — the host serves its extension API instead of shipping it on a registry, and resolves a command through `PATHEXT` before spawning it. Views get the SDK the same way.
- Browser extensions — say plainly what a plugin may do before it is installed, from its own manifest.
- [Go's checksum database](https://go.dev/ref/mod#checksum-database) and [Homebrew](https://brew.sh) taps — a registry that stores a pointer and a hash, never the code; a file that changed after it was listed fails the install.
- [Orca](https://github.com/stablyai/orca) and [Emdash](https://github.com/generalaction/emdash) — the Windows details: an encoded PowerShell hook command that survives any shell, and an app id the Start Menu shortcut carries.

MIT — see [LICENSE](./LICENSE).
