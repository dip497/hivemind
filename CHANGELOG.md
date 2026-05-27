# Changelog

All notable changes are documented here, in [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each release is published to [GitHub Releases](https://github.com/dip497/hivemind/releases) with prebuilt artifacts (`hive-linux-x86_64`, `hivemind-<version>-x86_64.AppImage`).

## [Unreleased]

## [0.0.1] — 2026-05-27

### Added
- First public OSS release.
- **CLI** (`hive`) — `init`, `init --agentic`, `new`, `mcp-stdio`, and friends. Single-binary distribution via `bun build --compile`.
- **Desktop app** — Electron + xyflow infinite canvas with terminal / diff / file-tree / editor / issues tiles, frame-as-workspace zones, persistent PTY daemon, Mosh-style replay (headless xterm + SerializeAddon), disk-backed snapshots, claude `--session-id` binding for deterministic resume across reboot.
- **MCP server** (`@hivemind/mcp`) — 9-tool stdio server wrapping `@hivemind/core` so claude can `get_issue`, `set_state`, `add_comment`, `mark_acceptance`, etc.
- **Templates** — per-workspace `.mcp.json` + `CLAUDE.md` + `.claude/skills/hive-work/SKILL.md` copied by `hive init --agentic`.
- **install.sh** — single script for both fresh install and in-place upgrade. Downloads prebuilt binaries from GitHub Releases by default; `--dev` flag clones and builds from source.
- **GitHub Actions** — `release.yml` (tag-driven build + publish on `v*.*.*`), `ci.yml` (typecheck + build + unit tests on every push / PR).

[Unreleased]: https://github.com/dip497/hivemind/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/dip497/hivemind/releases/tag/v0.0.1
