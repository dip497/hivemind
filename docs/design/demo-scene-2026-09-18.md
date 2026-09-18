# The demo scene: one person, one morning, twenty agents

Status: spec, 2026-09-18. What the website's screenshots and walkthrough must show, and why.
The captures are generated from this; if a shot disagrees with this file, the shot is wrong.

## The rule

**Everything on a screen is real output from real commands in a real repository**, produced by
the built app under `scripts/site-clip.mjs`. Two things are stand-ins, and only two:

- The agent CLI is a shim, because a capture cannot carry API keys. It prints the screens each
  provider's own manifest looks for, so the statuses, the grouping and the amber badge are
  produced by the real detector — not drawn.
- The permission prompt is scripted, because a blocked state is what the product is *for* and a
  shim cannot be asked for consent by a model that is not running.

Everything else — the diffs, the log, the file lists, the test counts — is this repository,
printed by the command shown. No invented filenames, no invented test results, no fake timers.
The previous hero was a hand-built HTML imitation with agents named `builder`/`scout`/`nurse`
and a `2:28` counter that counted nothing. That is the thing this file exists to prevent.

## The persona

A developer with five repositories open and no intention of watching any of them. They keep
fifteen to twenty agents busy at once — the point is throughput: an idle agent is wasted time,
and a human reading twenty terminals is the bottleneck. So the workspace's only job is to say
**which one of the twenty needs a person right now**, and to make answering it take two seconds.

That is why amber is reserved, why `N` jumps to the one that has waited longest, and why every
view groups by "needs you" first. The screenshots have to show a workspace that is *full* —
a screenshot with three agents in it argues for nothing.

## The scene

Five frames in one real repository — this one, cloned for the capture. Frames are zones bound to
a directory, which is how a person splits one codebase across areas of work; the only other real
repositories on the capture machine are private, and private code does not go in a screenshot.

| frame | agents | what they run |
|---|---|---|
| `views` | claude ×2, codex, pi | the renderer's own files: `git log`, a grep for `effectiveGlass` |
| `cli` | claude ×2, pi | `git log -- apps/cli`, `git show --stat` |
| `packages` | codex ×2, pi | `grep PROTOCOL_VERSION`, `ls examples/views/*/src` |
| `docs` | claude ×2, codex | the guide's files, `CHANGELOG.md` |
| `site` | claude, codex, pi | `wc -l` of the renderer; one has **finished** |

States, produced by the detector rather than asserted: **three waiting on a person** (two claude
edits, one codex command), **twelve working**, the rest quiet or done. The scene refuses to be
captured if the census does not come out that way.

## The beats, in order

1. **Full canvas.** Twenty tiles across five frames, everything running, nobody blocked yet.
   The claim: this is a normal amount of work, and it is legible.
2. **One turns amber.** `claude · hivemind` wants to edit `src/limits.ts`. It is the only amber
   thing on the screen, and the Layers rail counts it.
3. **Queue, and `N`.** The list puts it at the top; `N` jumps to it; the real diff is on the
   right, in its live terminal. Answer, and it resumes — the other nineteen never stopped.
4. **A second one, denied.** `codex · elastic` asks to run `terraform apply`. Deny is a first
   class answer, and the tile goes back to working on something else.
5. **The same work, drawn differently.** Board for what is in review; Tiled for one repo's panes.
   Switching costs nothing: the sessions are lent to the view, not owned by it.

The closing line is the product's whole argument: **you answer, they keep going.**

## What the site says about it

The homepage caption, the walkthrough's description and this file must agree on the numbers.
Today: twenty agents, five frames, one repository, three waiting. When the scene changes, they change
together — `scripts/site-clip.mjs` prints the census it captured, and that number is the one
the page is allowed to claim.
