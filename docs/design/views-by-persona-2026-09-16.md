# Views, by persona

Status: shipped. 2026-09-16. Queue, Tiled and Board replace the earlier examples, which
answered no question anyone had. A view earns its place when a specific person's job gets
easier, so these start from the person.

## What a view can and cannot know

This decides every design below, so it comes first.

- A view receives **frames** (id, title, colour), **tiles** (id, frame, kind, name), **selection**,
  **per-tile status** on subscription (`unknown | idle | working | blocked | exited`), the theme,
  its viewport and visibility. It never sees terminal content, command lines or files.
- It can **dock a live terminal** by declaring a rect; the host puts a real xterm there.
- **Only the active view is mounted.** Switching to Canvas unmounts it. A view therefore cannot
  record history while it is not on screen, and must not pretend to. Durations are shown only
  when the view observed the change, and persisted timestamps are labelled as "since".
- Status colours are the app's: working = `brand`, needs you = `warn`, idle = `fg3`,
  exited = `err`. A view that remaps them teaches the user to misread the rest of the app.

## Research, briefly

People running several agents describe one bottleneck in the same words: the operator, not the
model — *which agent is blocked, which one finished, which is safe to merge*. The tools they
reach for split three ways: tmux-style panes with live status for terminal natives; a board whose
columns are session states (in progress, waiting, review, done) with work-in-progress capped at
three to five; and attention dashboards for people running many at once.

From a study of a large open catalog of WebGL interface components: put the whole look of a
background in one fragment shader on one quad, so the cost is fill rate and nothing else; cap
pixel ratio; smooth the pointer toward a target; give interactive strips spring physics and
release sizes before measuring so the spring cannot fight its own layout; ship a few art-directed
variants rather than many knobs. Its shaders did not honour reduced motion. Ours do.

## Queue — the operator

**Who.** Runs six to twelve agents across three or four repositories. Their day is interrupts.

**Job.** Never leave an agent waiting on them. Work the "needs you" list to zero.

**Design.** A list ordered by urgency — *Needs you*, *Just finished*, *Working*, *Quiet*,
*Exited* — each row with a status mark that is a shape as well as a colour, the agent's name, its
frame, and how long it has been in that state when that is known. The selected agent's live
terminal is docked beside the list, so answering an approval is typing in the real terminal, not
opening something. `J`/`K` move and dock, `N` goes to the next agent that needs you. When the
docked agent stops needing you, the view offers the next one rather than jumping, because jumping
while someone types is hostile. With nothing waiting, the empty state is a quiet dot field whose
pulse follows how many agents are working — the one place a little delight belongs.

**Not.** A dashboard of charts. The operator needs the next action, not a report.

## Tiled — the terminal native

**Who.** Lives in tmux. Two to four agents on one feature — builder, tests, reviewer — and a shell.

**Job.** See and type into every terminal of this task at once, with no arranging.

**Design.** The active frame's terminals tile themselves: one fills the view, two split, three or
more take a main pane and a stack. Frames are tabs along the top, and a tab lights when something
in that frame needs you, so another task can call you without being visible. The tab strip is a
spring dock. Keys switch frames, promote a pane to main, and toggle main-and-stack against a grid.
Panes carry the host's own bar, so status, pop-out and undock are the app's controls.

**Not.** A second canvas. Nothing here is dragged or sized by hand.

## Board — the lead

**Who.** Starts longer tasks, checks in a few times a day, owns review and merge.

**Job.** Move each session from doing, to review, to done, and keep work in progress bounded.

**Design.** Columns *Doing*, *Needs you*, *Review*, *Done*. Status moves cards on its own where it
is certain — working goes to Doing, blocked to Needs you — and the lead's placement into Review or
Done persists, until the agent starts working again, which moves it back with a note saying so.
Doing shows its work-in-progress limit and warns past it. Clicking a card docks its terminal in a
panel for review. Cards pick up and settle with springs, and move between columns with arrows as
well as by dragging.

**Not.** A task tracker. Cards are sessions that exist; the board does not invent work.

## What is deliberately absent

No 3D. None of these jobs is easier in three dimensions, and the World view was removed for
being impressive and useless. A timeline of the day was considered and dropped: a view that
unmounts cannot see the day. Every view asks for no permissions.
