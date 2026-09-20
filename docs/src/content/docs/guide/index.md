---
title: Hivemind
description: A workspace for coding agents, on Linux, macOS and Windows.
---

Hivemind runs coding-agent CLIs alongside terminals, editors, file trees, and diffs — in one
window, on one canvas. Agents work in parallel; the workspace shows you which of them is waiting
on you.

<figure>
  <img src="../shots/view-canvas.webp" alt="The canvas: two frames, each holding agent and shell tiles, on a shared wallpaper." />
  <figcaption>The canvas — one frame per repository, tiles inside them</figcaption>
</figure>

## The model, in one picture

Three nouns. Everything in these docs is one of them.

<figure>
<svg viewBox="0 0 700 250" role="img" aria-label="A frame binds a directory; every tile spawned in that frame runs its process in that directory, locally or over one SSH connection.">
  <defs>
    <marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g font-family="var(--sl-font-mono)" font-size="12" fill="currentColor" stroke="currentColor">
    <rect x="1" y="30" width="300" height="100" rx="6" fill="none" stroke-opacity=".35"/>
    <text x="16" y="22" font-size="11" letter-spacing="1.2" stroke="none" opacity=".6">FRAME · api</text>
    <rect x="20" y="52" width="120" height="30" rx="4" fill="none" stroke-opacity=".5"/>
    <circle cx="36" cy="67" r="4" stroke="none" fill="var(--hm-attention)"/>
    <text x="48" y="71" stroke="none">builder</text>
    <rect x="160" y="52" width="120" height="30" rx="4" fill="none" stroke-opacity=".5"/>
    <circle cx="176" cy="67" r="4" stroke="none" fill="var(--hm-working)"/>
    <text x="188" y="71" stroke="none">scout</text>
    <rect x="20" y="92" width="260" height="26" rx="4" fill="none" stroke-opacity=".5"/>
    <text x="34" y="110" stroke="none" opacity=".65">shell · editor · diff</text>
    <rect x="1" y="166" width="300" height="76" rx="6" fill="none" stroke-opacity=".35"/>
    <text x="16" y="158" font-size="11" letter-spacing="1.2" stroke="none" opacity=".6">FRAME · web</text>
    <rect x="20" y="186" width="120" height="30" rx="4" fill="none" stroke-opacity=".5"/>
    <circle cx="36" cy="201" r="4" stroke="none" fill="var(--hm-done)"/>
    <text x="48" y="205" stroke="none">nurse</text>
    <rect x="160" y="186" width="120" height="30" rx="4" fill="none" stroke-opacity=".5"/>
    <text x="174" y="205" stroke="none" opacity=".65">shell #5</text>
    <path d="M305 80 H430" fill="none" marker-end="url(#ar)" stroke-opacity=".6"/>
    <text x="367" y="72" text-anchor="middle" font-size="11" stroke="none" opacity=".75">cwd</text>
    <path d="M305 204 H430" fill="none" marker-end="url(#ar)" stroke-opacity=".6"/>
    <text x="367" y="196" text-anchor="middle" font-size="11" stroke="none" opacity=".75">cwd, over ssh</text>
    <rect x="434" y="62" width="264" height="36" rx="4" fill="none" stroke-opacity=".5"/>
    <text x="450" y="85" stroke="none">~/src/api</text>
    <rect x="434" y="186" width="264" height="36" rx="4" fill="none" stroke-opacity=".5"/>
    <text x="450" y="209" stroke="none">ssh://box:/srv/web</text>
  </g>
</svg>
<figcaption>A frame binds one directory; every tile inside it starts there — the same whether that directory is local or on another machine</figcaption>
</figure>

- **Canvas** — one per project, saved with the repository.
- **Frame** — a named zone bound to a directory: a local repo, a git worktree, or an SSH host.
- **Tile** — one process in that directory: an agent, a shell, an editor, a diff.

## What the colours mean

A tile carries a dot, and the dot is the whole notification system. Amber is reserved: it is the
only colour that means *a human is being waited on*.

<span class="st st-working">working</span> &nbsp;
<span class="st st-attention">needs you</span> &nbsp;
<span class="st st-done">done</span> &nbsp;
<span class="st st-idle">idle</span>

Press <kbd>N</kbd> to jump to the next tile that needs you, <kbd>Esc</kbd> to release it, and
<kbd>⌘E</kbd> to change how the whole workspace is drawn.

## Four ways to look at the same work

The runtime owns frames, tiles and sessions; a view only arranges them. Switching costs nothing
and loses nothing.

<figure>
  <img src="../shots/view-queue.webp" alt="Queue view: agents grouped by status, the one needing attention at the top." />
  <figcaption>Queue — grouped by who needs you, keyboard-first</figcaption>
</figure>

<figure>
  <img src="../shots/view-board.webp" alt="Board view: tiles as cards in columns by status." />
  <figcaption>Board — the same tiles as cards, by status</figcaption>
</figure>

[See all four, and write your own →](views/)

## Start here

<ul class="doors">
  <li><a href="getting-started/"><b>Install and start</b><span>One command, then your first frame.</span></a></li>
  <li><a href="agents/"><b>Run agents</b><span>Which agents there are, and how they are detected.</span></a></li>
  <li><a href="agent-workflows/"><b>Drive them from the CLI</b><span>Spawn, read, approve, without the mouse.</span></a></li>
  <li><a href="extension-authoring/"><b>Write a view</b><span>The same protocol the built-ins use.</span></a></li>
</ul>

These docs follow the development branch. **Views, the view SDK, and the new settings commands
are development previews.** Check `hive --help` for what your installed version has.

For coding agents: [the documentation index](../llms.txt). Every guide is also plain Markdown
under `markdown/`.
