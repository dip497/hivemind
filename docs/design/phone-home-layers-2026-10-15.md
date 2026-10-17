# Phone Home as the Layers panel — 2026-10-15

The person: "how our side bar of dashboard is so nice … in phone are we having same things?",
"same type of folder icon … that filter component also same … do a proper architecture".

## Goal

Home on Android, iOS and the phone page reads as the desktop's Layers panel: the same marks
(a folder per frame, a branch for a worktree, each agent's own logo, a kind mark for other tiles),
the same fold arrows, counts and "needs you" pill, and the same View menu (status, activity,
group by, sort by), giving the same lists for the same choices.

## Facts

- The panel's rules are one TS module, `packages/hive-core/src/layers.ts` (`layersView`), used by
  the desktop alone. The phones run the Rust core (`crates/hive-phone`, linked by Android and iOS
  through `hive-phone-ffi`, by the phone page through wasm). A phone cannot run the TS module.
- The repo already keeps one contract across both runtimes: `conformance/home.json` is read by
  `packages/host/tests/home.test.ts` and `crates/hive-phone/tests/home.rs`.
- An agent's icon is data in its manifest (`viewBox`, `shapes` of path, rect, circle, ellipse,
  with transforms and arcs). 19 of the 22 published agents have one.
- A tile's status kind is one reading, `packages/agent-host/src/tile-status.ts`:
  exited → exited; waiting → its kind (permission, question, plan → plan_review, approval →
  awaiting_approval, other → blocked); working → working; anything else → idle.

## Design

1. **One contract, two runtimes.** `layersView`'s rules (status and activity filters, sort,
   group by status / date / agent / none, nesting under the starter) stay owned by `layers.ts`.
   The Rust core ports them in `hive_phone::layers`. Both are held to `conformance/layers.json`:
   the same tiles, choices and expected lists, read by a TS test and a Rust test. A change to the
   rules changes the file, and both sides fail until both follow.
2. **The core does all of Home's logic; the apps only draw.** `Home::shown` takes a `HomeView`
   (status, activity, group by, sort by, folded keys) and returns entries the apps draw as they
   come: projects and frames with `count`, `state` (what most wants a look) and `folded`; tiles
   with `unread`; section headings for the groupings that are not the tree; and `marks`, the mark
   of each agent a listed tile runs, once per agent however many tiles run it.
3. **Agent marks travel as data.** The host sends one `a:<agent>` row per agent on the Home
   stream, with the manifest's shapes. The core turns them into paths of absolute `M L C Q Z`
   (`hive_phone::mark`, using `svgtypes`), which Compose's `PathParser`, a 30-line Swift reader and
   an SVG `<path>` each draw. No icon table on any phone.
4. **Kind marks:** an agent's logo; a terminal glyph for a shell; a window for any other kind,
   as the panel draws a kind with no icon.
5. **Choices are the phone's own.** The View menu's choices, the folded keys and when the person
   last opened each agent (`seen`, by tile key) are kept by each app in one record, phone-wide,
   and passed to the core with each call. The core keeps nothing of them: Home is rebuilt from the
   stream on every launch. A tile never opened on the phone is never unread there.

## Not done here

- Machines as a View choice: the phone's machine chips are its machine filter.
- Snooze and Recents: the phone has neither today.
