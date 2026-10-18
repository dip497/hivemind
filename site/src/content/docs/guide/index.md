---
title: Hivemind
description: A workspace for coding agents.
---

Hivemind runs your coding agents side by side with terminals, a code editor and a browser, in one
window. It shows you which agent is waiting on you.

<figure>
  <img src="../shots/showcase/waiting-on-you-board.webp" alt="The canvas: the Layers list of projects and their agents, an agent's terminal, and a widget listing the two agents waiting on you." />
  <figcaption>The canvas, with the Layers panel beside it</figcaption>
</figure>

## How it fits together

<figure>
<svg viewBox="0 0 700 250" role="img" aria-label="A frame binds a directory; every tile spawned in that frame runs its process in that directory, locally or on a saved machine.">
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
    <text x="34" y="110" stroke="none" opacity=".65">shell · code · browser</text>
    <rect x="1" y="166" width="300" height="76" rx="6" fill="none" stroke-opacity=".35"/>
    <text x="16" y="158" font-size="11" letter-spacing="1.2" stroke="none" opacity=".6">FRAME · web</text>
    <rect x="20" y="186" width="120" height="30" rx="4" fill="none" stroke-opacity=".5"/>
    <circle cx="36" cy="201" r="4" stroke="none" fill="var(--hm-done)"/>
    <text x="48" y="205" stroke="none">nurse</text>
    <rect x="160" y="186" width="120" height="30" rx="4" fill="none" stroke-opacity=".5"/>
    <text x="174" y="205" stroke="none" opacity=".65">shell #5</text>
    <path d="M305 80 H430" fill="none" marker-end="url(#ar)" stroke-opacity=".6"/>
    <text x="367" y="72" text-anchor="middle" font-size="11" stroke="none" opacity=".75">runs in</text>
    <path d="M305 204 H430" fill="none" marker-end="url(#ar)" stroke-opacity=".6"/>
    <text x="367" y="196" text-anchor="middle" font-size="11" stroke="none" opacity=".75">runs in, on a machine</text>
    <rect x="434" y="62" width="264" height="36" rx="4" fill="none" stroke-opacity=".5"/>
    <text x="450" y="85" stroke="none">~/src/api</text>
    <rect x="434" y="186" width="264" height="36" rx="4" fill="none" stroke-opacity=".5"/>
    <text x="450" y="209" stroke="none">machine://box/srv/web</text>
  </g>
</svg>
<figcaption>A frame binds one directory; every tile inside it starts there — the same whether that directory is local or on a saved machine</figcaption>
</figure>

| Word | What it is |
|---|---|
| **Workspace** | One project folder and everything open for it. |
| **Frame** | A named area bound to one folder: the project, a git worktree, or a folder on another machine. |
| **Tile** | One thing in a frame: an agent, a terminal, the Code tile, a browser, a tool. |

## What the colours mean

<span class="st st-working">working</span> &nbsp;
<span class="st st-attention">needs you</span> &nbsp;
<span class="st st-done">done</span> &nbsp;
<span class="st st-idle">idle</span>

Amber always means *a person is being waited on*. The bell in the Layers panel counts those and
jumps to the next one.

## Where to go

<ul class="doors">
  <li><a href="getting-started/"><b>Install</b><span>One command, then your first agent.</span></a></li>
  <li><a href="agents/"><b>Run agents</b><span>Install, start, put to sleep.</span></a></li>
  <li><a href="agent-workflows/"><b>Coordinate agents</b><span>One agent drives others with <code>hive ctl</code>.</span></a></li>
  <li><a href="machines/"><b>Use another computer</b><span>Run agents on a machine over ssh.</span></a></li>
  <li><a href="multiplayer/"><b>Work with others</b><span>Share a workspace.</span></a></li>
  <li><a href="plugins/"><b>Extend it</b><span>Agents, views, widgets and tools.</span></a></li>
  <li><a href="api/"><b>Drive it from a program</b><span>Tokens and the workspace API.</span></a></li>
  <li><a href="cli/"><b>CLI reference</b><span>Every <code>hive</code> command.</span></a></li>
</ul>

These docs follow the latest release; `hive --help` shows what your version has. The iOS and
Android apps are development previews. For coding agents: [the documentation index](../llms.txt);
every page is also plain Markdown under `markdown/`.
