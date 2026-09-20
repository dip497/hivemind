# Security

## Reporting a vulnerability

Use **[Report a vulnerability](https://github.com/dip497/hivemind/security/advisories/new)** on
this repository. It is private: only you and the maintainer can read it until there is a fix.
Please don't open a public issue for something exploitable.

Tell us what you did, what happened, and what you expected. A minimal repository, manifest or
view that reproduces it is worth more than a description. You'll get a first reply within a few
days; if a fix is needed it ships in the next release, and the advisory is published with credit
unless you ask otherwise.

Fixes land on the latest release. There are no backports to older versions.

## What we consider a vulnerability

Hivemind runs coding agents on your machine, so the line matters more than usual.

**In scope** — anything that crosses a boundary the app promises to hold:

- A **view** (a sandboxed plugin) reaching the filesystem, the network, node, another view, or
  the app's own internals; escaping its `hm-view://` origin or its CSP.
- An **agent manifest** doing something its install review never disclosed: running a command
  that was not shown, reading outside the directories it named, or writing outside its own folder.
- **Installing a plugin** from the registry when a file does not match the checksum that was
  published, or a plugin taking an id reserved for another.
- The **control plane** (`hive ctl`, the HCP socket, the pty daemon) accepting a caller it should
  not: another user on the machine, a remote host, or a tile acting as one it is not.
- **Secrets or tokens** written where they should not be: a world-readable file, the terminal
  buffer, a log, or an agent's prompt.
- The **installer** or an upgrade running or writing something it did not fetch over TLS and check.

**Not vulnerabilities**, though still worth reporting as issues:

- What an agent does after you approve it. An agent you install runs commands on your machine;
  that is the product, not a flaw.
- A third-party agent CLI's own bugs — report those to that project.
- A manifest asking for something alarming, as long as the review says so before you install it.
- Anything that needs an attacker to already have your user account, or to hand you a repository
  you then open and approve.

## What the app promises

- **Views run sandboxed.** Their own origin, a strict CSP, no filesystem, no network, no node, no
  app API. They talk to the workspace over one validated channel, and a view that floods it or
  burns CPU is disabled for the session.
- **Agents are declarative.** An agent is a manifest, checked the same way whoever wrote it, and
  what it may do is shown before it installs.
- **Plugins are pinned.** The registry stores a pointer and a SHA-256 per file; a file that
  changed after it was listed fails the install rather than being trusted.
- **Sockets are yours.** The control-plane socket is `0600`, and its token lives beside it.

Full detail: [the architecture guide](https://hivemind.griiken.com/guide/).
