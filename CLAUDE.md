# CLAUDE

## Adding or completing an agent integration

Wiring a new CLI agent (kiro, gemini, amp, …) — or finishing a half-wired one — follows
the `adding-an-agent-provider` skill in `.claude/skills/adding-an-agent-provider/`.
Read it before touching `providers/`, `agents.tsx`, or `agent-state.ts`.

The part people skip: **probe the real binary before deciding what it supports.** A
provider PR that assumes "no hooks / no session ids" without running `--help` ships an
agent the control plane cannot drive — `hive ctl read` times out, `hive ctl workflow`
gathers nothing, and a tile waiting on approval notifies "Finished". `checklist.md` next to the
skill is the definition of done; it goes in the PR description.

<!-- release:start -->
## Release management

This project ships prebuilt binaries via [GitHub Releases](https://github.com/dip497/hivemind/releases). End users install with `install.sh`, which downloads the latest release assets — no toolchain on the user's box. The release pipeline is fully automated; you (Claude or the maintainer) do NOT build locally.

### How to cut a release

```bash
# from a clean main branch, in sync with origin/main:
./scripts/release.sh             # 2026.9.0, 2026.9.1 … then 2026.10.0 — computed, nothing to choose
./scripts/release.sh 2026.9.4    # explicit version
./scripts/release.sh --dry-run   # preview without writing
```

What it does (`scripts/release.sh`):

1. Pre-flight: rejects a dirty tree, requires `main`, requires sync with `origin/main`.
2. Bumps `version` in every workspace `package.json` in lockstep.
3. Inserts a `[X.Y.Z] — YYYY-MM-DD` section into `CHANGELOG.md` under `[Unreleased]`.
4. Commits `chore(release): vX.Y.Z` and creates an annotated tag.
5. Pushes branch + tag → fires `.github/workflows/release.yml` on GitHub Actions.

### What the workflows do

- **`.github/workflows/ci.yml`** runs on every push to `main` and PR: typecheck + build + unit tests (`pnpm test:unit`). Heavy Playwright e2e is intentionally NOT run here — release builds validate the full build path.
- **`.github/workflows/release.yml`** runs on `v*.*.*` tags (and manual `workflow_dispatch`). Four jobs: `build-linux` (ubuntu) → `hive-linux-x86_64` + `hivemind-<version>-x86_64.AppImage`; `build-linux-arm64` (ubuntu-24.04-arm) → `hive-linux-arm64` only (a remote-machine CLI, no desktop); `build-macos` (macos-14, Apple Silicon) → `hive-darwin-arm64` + `hivemind-<version>-arm64-mac.zip`; `publish` downloads their artifacts and creates the GitHub Release. A manual `workflow_dispatch` is BUILD-ONLY unless you pass `-f publish=true` — use `gh workflow run release.yml --ref <branch> -f tag=vX.Y.Z-test` to smoke-test a platform's build without cutting a release; the assets land as run artifacts. Each build job compiles the CLI with `bun build --compile` (no `--target` — host arch; the Linux jobs then run `apps/cli/tests/sessions.test.ts` against the binary via `HIVE_BIN`, so a broken embedded pty addon fails the release), builds the renderer + main with `electron-vite`, then packages via `pnpm deploy` + `electron-builder`.

  Windows specifics: `build-windows` (windows-latest) produces `hive-windows-x64.exe` + `hivemind-<version>-x64-win.zip`, but it is `continue-on-error: true`, is NOT in `publish`'s `needs`, and its assets are deliberately absent from the release `files:` list — the platform builds but has never been launched, and an unvalidated platform must not be able to break a Linux/macOS release. Shipping it is one edit: add those two names to `files:`. The job also parse-checks `install.ps1` (the only Windows host the project has) and asserts the unpacked `win32-x64` `conpty.node` + `conpty.dll` made it into the bundle (Windows drives ConPTY — there is no `pty.node`, and a `.dll` is not covered by electron-builder's implicit native-module unpacking), because nothing else fails when the native module is missing or wrong-arch.

  macOS specifics worth not re-deriving: we have no Apple Developer cert, so `mac.identity` is `null` (electron-builder skips signing entirely — it does NOT fall back to ad-hoc). An arm64 bundle with an invalid signature is SIGKILLed by the kernel, and electron-builder's repack invalidates the signature Electron ships with — so the workflow re-applies an ad-hoc signature (`codesign --force --deep --sign -`) and archives with `ditto` (preserves the framework symlinks `zip` mangles). Users still hit Gatekeeper quarantine; `install.sh` strips the xattr. Only arm64 is published: the bundle carries a host-arch `@lydell/node-pty`, so cross-arch packaging would ship the wrong native module. Intel macs use `--dev`.

### Pre-release checklist

Before running `./scripts/release.sh`:

- [ ] All e2e tests green locally: `cd apps/desktop && unset ELECTRON_RUN_AS_NODE && xvfb-run -a --server-args="-screen 0 1600x1000x24" pnpm test:e2e --retries=0` (99 tests across 29 specs, all must pass; the profile is isolated per run — see apps/desktop/AGENTS.md). **Run this on a quiet machine.** The suite takes 13-16 minutes and launches Electron ~30 times; at system load 25-30 on 16 CPUs a rotating handful of specs fails on cold-boot and timing, every one of which passes in isolation. Check `uptime` first — a red run on a loaded box is not evidence of a regression.
- [ ] Canvas perf unchanged within noise vs the previous release: `apps/desktop/scripts/perf-canvas-effects.mjs`. Measure on a real display with the backend recorded — **absolute FPS, frame-time and latency gates are not valid under xvfb**, which renders on the llvmpipe CPU rasterizer; see `docs/design/performance-native-2026-09-09.md`. On a live desktop a capped run can read ~1 FPS for anything that moves while the page's main thread sits idle — each present waiting on a vsync that does not arrive. Run the A/B uncapped (`PERF_EXTRA_ARGS="--disable-gpu-vsync --disable-frame-rate-limit"`) and check the recorded `session.type` — after a reboot the desktop may be Wayland, not the X display you expect (`docs/design/perf-streaming-2026-09-11.md`).
- [ ] Unit tests green: `pnpm test:unit` from `apps/desktop`.
- [ ] Installer tests green: `bash scripts/install-plan-test.sh` + `bash scripts/install-macos-test.sh` (the second drives the real Darwin helpers with `ditto`/`xattr` shimmed, so the mac path is covered without a mac). The first asserts the release-asset names install.sh asks for match what release.yml uploads — a rename on either side breaks every install.
- [ ] CHANGELOG `[Unreleased]` section has at least one entry describing the user-visible change.
- [ ] No uncommitted changes (`git status` clean).

### Debugging a failed release workflow

```bash
gh run list --limit 5 --json status,conclusion,name,databaseId    # find failed run id
gh run view <id> --log-failed | tail -50                          # tail the error
gh run rerun <id>                                                  # retry (rare)
```

Common failure modes seen so far:

- **"package.json must be under apps/desktop"** — electron-builder rejects pnpm symlinks to sibling workspace packages. Fixed by `pnpm --filter @hivemind/desktop deploy desktop-deploy` BEFORE running electron-builder inside the deploy dir.
- **"Cannot compute electron version"** — `pnpm deploy --prod` strips devDeps (including electron itself). Use `pnpm deploy --legacy` without `--prod`.
- **"Multiple versions of pnpm specified"** — `pnpm/action-setup` shouldn't pin `version` when `packageManager` is set in root `package.json`.

If the release workflow fails but the tag is pushed: delete the tag (`git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z`), fix the workflow, re-tag.

### Versions

Calendar versions: `YYYY.M.N`, the Nth release of that month, counting from 0 (`2026.9.0`,
`2026.9.1`, then `2026.10.0`). The script computes it, so there's no bump to decide. It is still a
valid semver (no leading zeros), which npm, electron-builder and the update check need, and it
sorts above every `1.x` release.

The version number says **when**, not **what broke**. Compatibility lives in the contracts that
have their own version — the view protocol (`PROTOCOL_VERSION`), agent manifests
(`manifestVersion`), package bundles (`apiVersion`), `settings.json` (`v`) — and a plugin that needs
a newer app says so with `minAppVersion`. A change that breaks any of them, the `hive` CLI or a
`hive ctl --json` shape starts its CHANGELOG line with **Breaking:**.

### Hand-off rule

If you (Claude) made any change that ships to users — code, dependency, install behavior, `hive ctl` surface — append a one-line entry to `CHANGELOG.md` under `## [Unreleased]` BEFORE handing the session back. The maintainer can then cut a release with `./scripts/release.sh` and the changelog is ready.
<!-- release:end -->
