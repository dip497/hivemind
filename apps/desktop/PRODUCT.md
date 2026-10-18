# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

A desktop app (Electron) on Linux, macOS and Windows, drawn with web technology. It is one design
language on all three, not a native one per OS; it should still feel at home on each (the OS's own
UI font, nothing Mac-only).

## Users

Two first-class users, equally:

- **A developer supervising agents alone.** They run several CLI coding agents (Claude Code, Codex,
  Pi, Cursor, Droid, …) in parallel on one or more repositories, for hours, and need to see at a
  glance which is blocked, which finished, and what changed.
- **A small team sharing a workspace.** Several people, devices and machines (SSH hosts) see and
  drive the same agents and terminals together.

## Product Purpose

One screen for every agent, terminal, diff, issue and browser you work with, instead of cycling
through windows. Agents keep running whatever the screen shows; the screen is yours to arrange.
Success is a person always knowing what needs them, and never losing an agent's work to a
window they forgot.

## Positioning

**Everything is pluggable.** Agents are manifests, and so are the views (the canvas itself can be
replaced), tools (tiles), widgets and themes, installed from HiveHub or written yourself; the app's
own pieces use the same contracts as anyone's, with no special built-ins. Agents can drive agents
(`hive ctl`: spawn, watch, read, approve). It works with any CLI agent, on your own machines.

## Operating Context

- Open all day, next to terminals full of streaming output; most of the time the person is reading
  an agent, not the chrome.
- Work is grouped into frames: a frame bound to a folder is a project, its worktrees nest under
  it, a frame without a folder is a group. Workspaces are saved per folder.
- Agents and people meet in the same screen: notifications, approvals, plans to review, issues.

## Capabilities and Constraints

- The user owns the look: wallpaper, glass, accent, presets and terminal colours are theirs, so
  every surface must stay legible and calm on any of them.
- Keyboard shortcuts follow familiar editor conventions (VS Code's today). **Undecided:** importing
  a keymap from another IDE (VS Code, JetBrains, …) instead of a fixed "keyboard-first" set.
- Plugins (views, tools, widgets) run sandboxed and are drawn by the app's own UI kit where they
  can be; their contracts are versioned (view protocol, manifests).
- Calendar versions (`YYYY.M.N`); prebuilt releases for Linux x86_64, macOS Apple Silicon and
  Windows x64.

## Brand Commitments

- The name is **hivemind**, lower case.
- Voice: plain words, short sentences, no jargon in what a person reads.

## Evidence on Hand

- Screenshots in `site/public/shots/` (the canvas, views).
- Plugins published on HiveHub (hivehub.griiken.workers.dev).
- No customer testimonials, usage numbers or benchmarks are on hand; none may be invented.

## Product Principles

1. **Quiet until it needs you.** Long sessions next to busy terminals: the chrome stays calm, and
   only what waits on a person (blocked, asking, a plan to review) raises its voice.
2. **Nothing is special.** The app's own views, tools and widgets are plugins like anyone's; a new
   need extends the plugin contract instead of adding a one-off.
3. **The agents keep running.** No view change, crash or switch may cost a running session its
   work or its screen.
4. **Yours to shape.** The person decides the look and the layout; defaults are good, never
   imposed.
5. **One way to do a thing.** Each action has one owner and one place, reachable the same way
   from the panel, the canvas and the keyboard.
