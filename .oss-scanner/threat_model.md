# Threat model: Hivemind

Report vulnerabilities privately through
[Report a vulnerability](https://github.com/dip497/hivemind/security/advisories/new) or to the
contact in this project's enrolment. `SECURITY.md` is the public version of this file; this one adds
where each boundary lives in the code. Paths are relative to the repository root.

## What Hivemind does

Hivemind is a desktop app for running coding agents (Claude Code, Codex, Pi and other CLIs) side
by side on a canvas, one terminal tile per agent, with git, issues, notes, widgets and views beside
them. Everything runs on the person's own machines. The parts:

| Part | Where | What it is |
|---|---|---|
| Desktop app | `apps/desktop` | Electron. Main process (`src/main`), renderer (`src/renderer`), and the pty daemon that owns every terminal (`packages/agent-host/src/pty-daemon.ts`) |
| `hive` CLI and headless host | `apps/cli`, `packages/host` | Bun. `hive ctl` drives the canvas; `hive host` serves the same workspace API with no window |
| Workspace API | `spec/workspace-api.md`, `packages/workspace-api`, `packages/workspace-host` | One JSON API served to the app's windows, local programs (`drive.sock`), agents and network peers |
| Agents | `packages/hive-agents` | Each agent CLI is a declarative manifest (`agent.yaml`), never code (`spec/agents.md`) |
| Plugins | `packages/hive-core`, `packages/view-host`, `packages/hive-view-sdk` | Views, widgets and tools, installed from a folder or from HiveHub, the plugin registry |
| hive-net | `crates/hive-net` | Rust, on iroh. A device's network endpoint, and the server roles anyone can run for their own devices: relay, lookup, access, push, the phone page |
| Phone | `crates/hive-phone`, `crates/hive-phone-ffi`, `crates/hive-web`, `apps/ios`, `apps/android` | The phone's core in Rust, linked by the native apps and compiled to wasm for the phone page served at `https://<relay>/phone/` |
| Rust agent host | `crates/agent-host` | A prototype of the agent host's status fold, held to the same conformance suite; not shipped |

An agent the person starts runs as the person, with their files, keys and network. That is the
product, and it shapes what counts as a boundary below.

## Where untrusted input enters

1. **Plugins from HiveHub or a folder.** Three kinds, three trust levels:
   - **Views** run untrusted. Each is a page on its own `hm-view:` origin, in an iframe with
     `sandbox="allow-scripts allow-forms"` and no `allow-same-origin`
     (`apps/desktop/src/renderer/src/workspace/views/community/CommunityView.tsx`), served with a
     CSP of `default-src 'none'`, `connect-src 'none'`, `frame-src 'none'`, `form-action 'none'`
     (`pluginCsp` in `packages/hive-core/src/view-files.ts`): a form fires its `submit` event and
     goes nowhere. Files are confined to the package by path and realpath (`resolvePackageFile`,
     same file). A view talks only over one `MessageChannel`; every message is parsed and refused
     if malformed
     (`parsePluginMessage` in `packages/hive-view-sdk/src/protocol.ts`), rate-limited and disabled
     for the session past its budget (`LIMITS` in `packages/view-host/src/link.ts`), and a view
     burning CPU is disabled by a watchdog (`startViewWatchdog` in
     `apps/desktop/src/main/view-packages.ts`). What it may call is held to the permissions it
     declared and the person approved (`VIEW_PERMISSIONS`, `COMMAND_PERMISSION` in `protocol.ts`;
     `granted()` in `link.ts`).
   - **Widgets** run untrusted, each in its own Web Worker built from the app's prelude plus the
     widget's code (`apps/desktop/src/renderer/src/board-objects/widget-runtime.ts`,
     `packages/hive-core/src/widget-api.ts`). They draw a tree of data nodes the app renders as
     React elements, never HTML (`WidgetBody.tsx`), and reach the workspace only through `hive.hm`
     calls held to their declared permissions.
   - **Tools** are trusted like the app: a tool's code is imported into the app window over
     `hm-plugin:` and may run commands (`apps/desktop/src/main/tool-packages.ts`,
     `packages/hive-core/src/tool-format.ts`). One installed stays off until the person switches it
     on. A tool's background service gets a drive-socket grant at its declared role, not the
     install's token (`packages/host/src/services.ts`, `packages/host/src/grants.ts`).
   - **Agent manifests** are data: what they may declare is closed (`defFromManifest` in
     `packages/hive-agents/src/manifest.ts`), and what runs a command, reads outside its folder or
     installs hooks is disclosed before install (`agentDisclosures`, same file).
   - **The registry.** HiveHub's index pins each file by SHA-256. The app fetches each file over
     HTTPS with redirects refused and sizes capped, checks its hash, rejects any path that leaves
     the plugin's folder, and stages into a temporary folder before the same review a local folder
     gets (`parseCatalog`, `safeRelative`, `stageEntry` in `packages/hive-core/src/plugin-catalog.ts`).
2. **Network peers over hive-net.** Other devices of the same person, and guests they invited,
   reach a workspace over iroh QUIC connections authenticated by Ed25519 device keys. A device is
   the person's when it holds a certificate signed by the person key (`spec/identity.md`). The gate
   admits only the devices the app lists; any other device may only pair or ping
   (`crates/hive-net/src/gate.rs`, `crates/hive-net/src/daemon.rs`). Every call a peer makes is
   checked against its role, `view < edit < terminals < agents`, on arrival; a method no role names
   is the owner's alone (`mayCall`/`refusalOf` in `packages/workspace-api/src/roles.ts`, called from
   `packages/workspace-api/src/peers.ts`; grants in `packages/workspace-host/src/access.ts`).
   Every param a peer sends is untrusted (`spec/workspace-api.md`, "Params a host refuses").
3. **Pairing.** A new device proves it holds a six-word code (48 bits, five minutes, one use,
   void after three wrong proofs) with an HMAC over both device keys (`spec/pairing.md`,
   `packages/workspace-host/src/pairing.ts`).
4. **The hive-net server roles**, on the internet when someone runs them
   (`crates/hive-net/src/serve.rs`): the iroh relay and QUIC address discovery, pkarr and
   DNS-over-HTTPS lookup (`lookup.rs`), the access role that admits devices to a closed or
   proof-of-work network (`access/`, `spec/network-access.md`), the push role that passes
   encrypted notices to Apple, Google or a UnifiedPush distributor with guarded egress (`push/`,
   `egress/guarded.rs`, `spec/push.md`), and the static phone page (`pages.rs`). Every request to
   them is attacker-controlled.
5. **The phone page** (`crates/hive-web`). The pairing link travels in the URL fragment, so the
   server serving the page never sees it. The device seed is kept in IndexedDB sealed with AES-GCM
   under a non-extractable WebCrypto key (`crates/hive-web/www/app/store.ts`). It draws a remote
   agent's terminal through `alacritty_terminal` (`crates/hive-phone/src/screen.rs`) as text
   (`textContent` in `www/app/terminal.ts`), and shows views in a sandboxed iframe on a separate
   origin (`www/app/views.ts`). Everything a computer sends it, and every terminal byte, is
   untrusted.
6. **Agent output.** Terminal bytes from agents (and from anything an agent runs or reads: a
   repository, a web page, an issue) are untrusted. They reach the terminal emulators (xterm.js in
   the app, alacritty_terminal on the phone), status detection by manifest regex rules, titles,
   notifications, and every view and widget that shows them.
7. **Hook payloads.** Agent CLIs report events by running `hive-net hook <door>`
   (`crates/hive-net/src/hook.rs`), which writes JSON-RPC lines to `hook-door.sock`
   (`packages/agent-host/src/hooks/hook-door.ts`, 0600, lines capped at 4 MiB) after signing in
   with a token (`spec/hook-protocol.md`). The payload's content comes from the agent and is
   untrusted.
8. **Local programs and agents on the control plane.** `hcp.sock` (the pty daemon and the main
   process's control plane) and `drive.sock` (the workspace API) are 0600 files in the app's data
   folder (`packages/agent-host/src/pty-daemon.ts`, `packages/host/src/drive.ts`). The first message
   must name a token:
   - the install's token (`hcp.token`, 0600, `packages/agent-host/src/hooks/token.ts`) is the person;
   - a tile's token (`HCP_TOKEN`, an HMAC of the tile id under the install token) is that agent,
     scoped to its own tile and to the one workspace its tile is in, at the role `agents`;
   - a grant's token (`grant.create`) reaches only its listed workspaces at its role, and is kept
     only as a SHA-256 (`packages/host/src/grants.ts`).
   Agents are spawned with inherited control-plane tokens removed and their own injected
   (`packages/hive-agents/src/runtime-manifest.ts`).
9. **Remote machines over ssh.** The app runs `hive` on a machine the person names over OpenSSH
   (`packages/host/src/remote/ssh.ts`): hosts and users starting with `-` or holding whitespace or
   control characters are refused, remote commands are single-quoted (`shq` in
   `packages/hive-core/src/ssh.ts`). What a remote host sends back (terminal bytes, file lists, git
   output, paths) is untrusted.
10. **Repositories.** File names, branch names, diffs and git output from the repository a
    workspace is open on. File and git methods confine paths to the repository by path and
    realpath (`packages/host/src/repo-paths.ts`) and refuse values that look like options
    (`notOption` in `packages/host/src/git.ts`; `--` before paths in `git-adapter.ts`).
11. **The Browser tile.** A `<webview>` showing any web page, with its preload removed and Node
    off (`will-attach-webview` in `apps/desktop/src/main/index.ts`), and a local browser server on
    127.0.0.1 behind a cookie traded for a token, same-origin and Host checks
    (`apps/desktop/src/main/browser-server.ts`, `browser-gate.ts`). What a page may use (the
    camera, the microphone, the location, notifications, another program for a link…) is decided
    by the permission handlers on both sessions (`apps/desktop/src/main/permissions.ts`, rules in
    `permissions-core.ts`), on the requesting frame's URL: a site in a Browser tile asks the
    person on its tile, and the answer is kept per site and right until the app quits; a view's
    frame and a tool's page get nothing; the app's own page gets only notifications and clipboard
    writes.

## What matters most

1. The view and widget sandboxes: a view or widget reaching the filesystem, the network, Node,
   the app's IPC, another view, or a permission it was not granted.
2. Workspace scoping on the control plane and the workspace API: a tile token, grant token or
   tool service reaching another workspace, another tile, or the person's role.
3. hive-net's gate, pairing and role checks: a device that is not admitted, or a guest, calling
   what its role does not allow; pairing without the code; forging a device certificate.
4. The hive-net server roles facing the internet, and the parsers behind them (relay frames,
   pkarr packets, DNS queries, access and push requests, the phone page's paths).
5. Parsing of untrusted bytes in the app: terminal escape sequences, hook payloads, agent
   manifests, plugin manifests, the HiveHub index, peer messages, the view protocol.
6. Path confinement and argument injection in file, git and ssh methods.
7. Secrets: the install token, device and person keys, grant tokens, push credentials, written
   anywhere readable by others or shown to an agent or a peer.

## How to exercise it

The image built from `.oss-scanner/Dockerfile` has every dependency installed, the app built,
`crates/hive-net/target/debug/hive-net` built, and each crate's test binaries compiled. With no
network:

```bash
cd /src
pnpm test                                        # every package's tests and the CLI's (bun test),
                                                 # the host's under Node (tsx --test)
pnpm --filter @hivemind/desktop run test:unit    # the desktop's unit tests
(cd crates/hive-net && cargo test --offline)     # also hive-phone, hive-phone-ffi, agent-host
```

Useful starting points: `packages/host/tests/security.test.ts` (quoting, paths outside the repo,
symlinks, revisions as options), `packages/host/tests/drive.test.ts` (who the drive socket
refuses), `packages/agent-host/tests/token.test.ts`, `packages/view-host/tests/link.test.ts`,
`packages/hive-core/src/view-files.test.ts`, `packages/hive-core/src/plugin-catalog.test.ts`,
`packages/host/tests/remote-ssh.test.ts`, `packages/workspace-api/tests/peers.test.ts`,
`packages/workspace-host/tests/pairing.test.ts`, and the tests in `crates/hive-net/src/pages.rs`
and `gate.rs`. `pnpm hive host` starts the workspace API headless;
`hive-net serve --relay --bind 127.0.0.1:3340` starts a relay; `hive-phone` does in a terminal what
the phone does (`crates/hive-phone/README.md`). The Electron app itself and its Playwright e2e need
a display and are not set up in the image.

## How we rate severity

- **Critical**
  - A view or widget escaping its sandbox: running code with Node or the app's IPC, reading or
    writing files, reaching the network, or acting in another view.
  - Code execution on the person's machine from data alone: a network peer, a guest, a HiveHub
    index, a hook payload, terminal output, a repository's file or branch names, a remote host's
    replies.
  - A device that was never paired, or anyone on a hive-net server's port, driving a workspace
    or a terminal.
  - Installing a plugin whose files do not match the hashes HiveHub published.
- **High**
  - A tile token, grant token or tool service reaching another workspace or tile, or acting as
    the person.
  - A guest acting above its role (a `view` guest typing into a terminal, an `edit` guest
    starting an agent), or calling an owner-only method.
  - A view or widget using a permission it was not granted; an agent manifest running a command
    or installing a hook its install review did not show.
  - Path traversal or symlink escape out of a repository or a plugin folder; argument injection
    into git or ssh.
  - Another local user reaching a socket or token; a key or token written world-readable, into a
    log, a terminal buffer, an agent's prompt, or sent to a peer.
  - Memory unsafety or a crash reachable by a remote party in hive-net's server roles or the
    phone core.
- **Medium**
  - Denial of service of a hive-net server role or the app from a remote party.
  - Script injection in the Browser tile's chrome or the phone page's shell.
  - A view or widget exhausting the app before its budget disables it.
  - Information disclosure to an admitted peer beyond its role (a terminal's contents to a
    `view` guest).
- **Low**
  - Denial of service that needs local access as the same user.
  - Crashes from malformed input the person typed themselves.
  - Missing hardening with no demonstrated exploit.

A report is most useful with the boundary it crosses, a reproducer (a test in the style of the
files above is ideal), and a patch that keeps the behaviour and passes `pnpm test`.

## Out of scope

- **The agent CLIs themselves** (Claude Code, Codex, Pi, Gemini and others) and what an agent does
  after the person starts or approves it. An agent runs as the person; that is the product.
- **A tool the person installed and switched on.** Tools are trusted like the app, by design. So
  is an agent manifest whose install review disclosed what it does. Report a tool or view that
  does more than its review showed, not one that does what it said.
- **Anything that needs the person's user account already**, including an agent reading
  `hcp.token`, which the same user owns (`packages/agent-host/src/hooks/token.ts` says so), or a
  repository the person opens and approves an agent in.
- **OpenSSH and the remote machine's own security**: holding an ssh key that logs in as the person
  is the pairing for a remote machine (`docs/design/remote-machines-2026-09-11.md` §7b).
- **iroh, Electron, Chromium, xterm.js, alacritty_terminal** and other dependencies' own bugs,
  unless Hivemind uses them unsafely. `crates/vendor/` is a vendored copy.
- **HiveHub's server** and the GitHub workflows (`.github/`), the website (`site/`), the guide
  (`guide/`), `docs/`, `examples/`, `templates/`, `infra/` (a deployment example), the release
  installers `install.sh` and `install.ps1` (in scope only for running or writing something not
  fetched over TLS and checked, per `SECURITY.md`).
- **Design notes describing what is not built**, such as the `ssh -R` socket from a remote machine
  back to the laptop (`docs/design/remote-machines-2026-09-11.md` §7b, milestone M5).
