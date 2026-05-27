# Issue CRUD Audit — 2026-05-17

## TL;DR
- **Create is structurally impossible from the GUI.** `HiveIpc` exposes no create/write/delete method (`shared/ipc.ts:80-138`); the only mutating issue method is `updateIssueState`. There is also no `createIssue` helper in `@hivemind/core` (storage exports only the low-level `writeIssue(issue)` + `allocateId`). The renderer literally cannot construct a new issue file regardless of UI buttons. The empty-state UI in `App.tsx:176-199` even tells the user to drop to a terminal and run `hive new`.
- **Edit surface is read-only.** `IssuePeek.tsx` is a pure display: title (line 65), description, AC, activity, assignee, labels, parent, github are all rendered as static text/chips. The ONLY interactive control is the state dropdown (`StateSelect`, line 113-117) which is just `useUpdateState`. No title edit, no body edit, no assignee picker, no label editor, no cycle picker, no AC toggle, no comment composer, no delete.
- **Drag/drop + state dropdown work** (BoardView.tsx:19-27, IssuePeek.tsx:113-117), and ⌘K palette navigation works (CommandPalette.tsx:96-119) — but every other capability in the matrix is MISSING. Eight of eleven capabilities have ZERO code path. The user's report ("not able to update issue, not able to create new issue, so many gaps") is literally correct: the desktop app is a read-mostly viewer plus state-only mutation.

## Capability Matrix

| Capability | Status | Evidence | Fix needed |
|---|---|---|---|
| Create issue | **MISSING** | No `createIssue`/`writeIssue` on `HiveIpc` (`shared/ipc.ts:80-138`); no handler in `main/index.ts:81-101`; no preload bridge (`preload/index.ts:14-21`); no dev-bridge RPC (`dev-bridge/server.ts:142-189`); no `createIssue` helper in core (`packages/hive-core/src/storage.ts` exports only `writeIssue` + `allocateId`); no UI button anywhere — empty state literally instructs `hive new` in terminal (`App.tsx:194`). | Add `createIssue(root, {title, parent?, labels?, assignee?, cycle?}): Promise<Issue>` to core that combines `allocateId` + template body + `writeIssue` + `writeAgentContext`; wire through `HiveIpc` + main handler + preload + dev-bridge RPC; add `useCreateIssue` mutation; add a "+ New issue" button in `App.tsx` header and `BoardView` column footers; add ⌘N shortcut + "New issue" entry in CommandPalette. |
| Edit issue title | **MISSING** | `IssuePeek.tsx:65` renders `{issue.title}` inside an `<h1>` — no input, no `contentEditable`, no rename handler. | Add inline-editable title (or modal) in IssuePeek; new IPC `updateIssue(root, id, patch)` that loads, applies patch, writes back, appends activity. |
| Edit issue body (description / AC / activity) | **MISSING** | `IssuePeek.tsx:68-94` renders description through read-only `Markdownish`, AC as static checkboxes with NO onChange, activity as ordered list. Even the AC checkboxes (line 79-88) don't fire any handler when clicked. | Same `updateIssue` IPC + a markdown editor (textarea minimum) in IssuePeek; toggle handler for AC items that writes back through core. |
| Change state — drag | **PRESENT** | `BoardView.tsx:19-27` `handleDrop` → `useUpdateState`. `queries.ts:61-90` has optimistic update + rollback + invalidate. | None. |
| Change state — peek dropdown | **PRESENT** | `IssuePeek.tsx:113-117` `StateSelect` → `useUpdateState`. | None. |
| Change state — sidebar | **MISSING** | `Sidebar.tsx:120-141` `IssueQuick` only calls `onSelectIssue` (open peek); no state mutation affordance, no right-click menu. | Add a per-row state pill click-to-cycle OR right-click menu using `useUpdateState`. |
| Change state — list view | **MISSING** | `ListView.tsx:73-114` `Row` only fires `onOpen`; no inline state control, no DnD between groups. | Add a `StateIcon` click target or a quick keyboard binding (`s` then state letter). |
| Assign / re-assign | **MISSING** | IPC has no member/agent list method; IssuePeek (`IssuePeek.tsx:118-127`) renders assignee as static `<span>`. No picker, no list of agents. `config.yaml` has agent list (per `storage.ts:73-91`) but it's not exposed over IPC. | Add `listMembers(root)` + `listAgents(root)` IPC (reading `config.yaml`); add an assignee combobox in IssuePeek; reuse new `updateIssue` for the write. |
| Add / remove labels | **MISSING** | `IssuePeek.tsx:135-142` renders labels via static `<LabelChip>`. No `+ add label` button, no removal X. No `listLabels` IPC. | Build a multi-select chip editor (derive available labels from `useIssues`); patch via `updateIssue`. |
| Set cycle | **MISSING** | `IssuePeek.tsx` has no Cycle row at all (cycles section absent from the right panel, lines 111-155). `useCycles` exists in `queries.ts:53-59` but is never consumed by any component. | Render a Cycle PropRow with a dropdown sourced from `useCycles`; patch via `updateIssue`. |
| Add comment / activity | **MISSING** | Activity is render-only (`IssuePeek.tsx:95-109`); no composer, no IPC. Core has `appendActivity` (`storage.ts:407-412`) but it's used only by `updateIssueState` server-side. | Add `appendIssueActivity(root, id, message)` IPC wired to core's `appendActivity` + `writeIssue` + `writeAgentContext`; add a comment box at the bottom of the Activity section. |
| Delete / cancel issue | **PARTIAL** | Soft-cancel POSSIBLE via state dropdown — `STATE_ORDER` includes `cancelled` (it's filtered out of board by default `BoardView.tsx:17` so newly-cancelled issues vanish from board with no undo). Hard delete: `deleteIssueFile` exists in core (`storage.ts:175-195`) but is not exposed on `HiveIpc`/preload/dev-bridge/UI. | Expose `deleteIssue(root, id)` IPC; add a "Delete" button in IssuePeek footer with confirm; add a "Show cancelled" toggle in `FilterBar` since current default hides them (`BoardView.tsx:14`, `ListView.tsx:12`). |
| Open in palette + drill | **PRESENT** | `CommandPalette.tsx:96-119` dispatches `hivemind:open-issue` → `App.tsx:32-39` listener sets `peekId`. | None. |
| Create cycle | **MISSING** | `writeCycle` exists in core (`storage.ts:286-297`) but no IPC/preload/dev-bridge/UI exposure. `useCycles` query exists, no `useCreateCycle` mutation. | Add `createCycle(root, {id, name, start_at, end_at})` IPC; add a "+ New cycle" UI in a (currently non-existent) cycles panel. |

## Critical findings (severity-ordered)

### 1. CRIT — IPC contract has no create/update/delete for issues
**Where:** `apps/desktop/src/shared/ipc.ts:80-138`
**Symptom:** No matter what UI you build, the renderer cannot create, rename, edit, comment on, or delete an issue. Only state changes work.
**Root cause:** `HiveIpc` interface declares only `listIssues`, `readIssue`, `listCycles`, `updateIssueState`. Main handlers (`main/index.ts:88-101`) mirror exactly that — nothing more. Preload (`preload/index.ts:15-21`) and dev-bridge RPC table (`dev-bridge/server.ts:142-189`) mirror it again. The whole pipeline is structurally write-blocked for everything except state.
**Fix:** Extend the contract in lock-step across all four files (this is the bulk of the work):
```ts
// shared/ipc.ts — add:
createIssue(root: string, opts: {
  title: string; parent?: string; labels?: string[];
  assignee?: { id: string; type: "member" | "agent" };
  cycle?: string; description?: string;
}): Promise<Issue>;
updateIssue(root: string, id: string, patch: Partial<Pick<
  Issue, "title" | "labels" | "assignee" | "cycle" | "parent" | "github" | "sections"
>>): Promise<Issue>;
appendIssueActivity(root: string, id: string, message: string, who?: string): Promise<Issue>;
deleteIssue(root: string, id: string): Promise<void>;
listCycles(root: string): Promise<Cycle[]>;            // already exists
createCycle(root: string, opts: { id: string; name: string; start_at?: string; end_at?: string }): Promise<Cycle>;
listMembersAndAgents(root: string): Promise<{ members: {id:string}[]; agents: {id:string}[] }>;
```
Then add `ipcMain.handle` in `main/index.ts`, the `ipcRenderer.invoke` line in `preload/index.ts`, and the entries in `dev-bridge/server.ts` `RPC` map AND the `window.hive = {...}` table inside `PREVIEW_SCRIPT` (line 109-137). Skipping the dev-bridge will silently break browser preview because dev-bridge is a parallel implementation, not a wrapper.

### 2. CRIT — No `createIssue` helper exists in `@hivemind/core`
**Where:** `packages/hive-core/src/storage.ts:170-173` (only `writeIssue(issue)`); `packages/hive-core/src/index.ts:1-5` (re-exports nothing higher-level)
**Symptom:** Even after wiring IPC, the main handler has nothing to call — it would have to manually allocate IDs, write frontmatter, format body, etc.
**Root cause:** The CLI presumably has this logic inline in its `new` command; it was never extracted into a reusable function.
**Fix:** Add to `storage.ts`:
```ts
import { SAMPLE_ISSUE_BODY } from "./templates.js";
export async function createIssue(root: string, opts: {
  title: string; parent?: string; labels?: string[];
  assignee?: { id: string; type: "member" | "agent" };
  cycle?: string; description?: string;
}): Promise<Issue> {
  const { id } = await allocateId(root);
  const finalId = opts.parent ? `${opts.parent}.${nextSubIdFor(opts.parent, root)}` : id;
  const now = new Date().toISOString();
  const issue: Issue = {
    id: finalId, title: opts.title, state: "todo",
    parent: opts.parent, labels: opts.labels ?? [],
    assignee: opts.assignee, github: undefined, cycle: opts.cycle,
    created: now, updated: now,
    path: issuePath(root, finalId),
    sections: { description: opts.description ?? "", acceptanceCriteria: [], activity: [], extra: "" },
    raw: SAMPLE_ISSUE_BODY,
  };
  await writeIssue(issue);
  return issue;
}
```
(Sub-issue id allocation needs care — if parent is set, scan parent's child dir for the highest `.N` and increment. Don't reuse `allocateId` for sub-issues since that bumps top-level `next_id`.)

Also add a similar `updateIssue(root, id, patch)` that load-merges-writes and `appendActivity`s the diff.

### 3. CRIT — IssuePeek pretends to be an editor but is 100% read-only
**Where:** `apps/desktop/src/renderer/src/components/IssuePeek.tsx:46-156`
**Symptom:** User clicks a card expecting to edit; the slide-over looks like a Linear/Jira detail view but nothing except the state dropdown does anything. Clicking AC checkboxes does nothing (no onChange). Clicking on a label does nothing. There's no text input anywhere.
**Root cause:** The component was never built with edit affordances. Title is `<h1>` (line 65), description is `<Markdownish>` (line 71), AC checkboxes are `<span>` (line 78-88), labels are `<LabelChip>` (line 138), activity is `<ol>` (line 97-107).
**Fix:** Two-phase.
1. **Inline edits via `updateIssue`:** make title an `<input>` that commits on blur/Enter; AC `<span>` → `<button>` that flips `done` and patches `sections.acceptanceCriteria`; label chips get an X + a "+" dropdown; assignee + cycle become combobox dropdowns sourced from new `listMembersAndAgents` / existing `useCycles`.
2. **Body editor:** swap `Markdownish` for a `<textarea>` in edit mode (toggle pencil icon); on save, patch `sections.description`. The `Markdownish` renderer at line 223-256 also drops inline code, links, headings, and emphasis — fine for v0 viewing but cannot round-trip an edit. Long term, swap for `react-markdown` + a simple markdown textarea (or a CodeMirror tile if you want syntax highlighting).
3. **Activity composer:** add a `<textarea>` + Post button below the activity list bound to a new `useAppendActivity` mutation.
4. **Delete button:** "..." overflow in header with Delete (confirm prompt) → `useDeleteIssue`.

### 4. CRIT — Dev-bridge will silently drift on every new IPC method
**Where:** `apps/desktop/src/dev-bridge/server.ts:109-137` (`window.hive` table inside `PREVIEW_SCRIPT`) AND lines 142-189 (`RPC` server table) — these are hand-mirrored copies of the IPC contract with NO type safety against `HiveIpc`.
**Symptom:** Browser preview (`gsd-browser`) silently breaks for any new method whose name is added to preload but not to both halves of dev-bridge. The renderer just gets `undefined is not a function` or "unknown RPC method".
**Root cause:** Three parallel implementations of the same contract with zero type linkage. Adding `createIssue` to preload alone gets you a working desktop build and a broken browser preview.
**Fix (defensive):** When you add the new IPC methods, add them in all THREE places in lock-step. Better fix (later): generate the dev-bridge `window.hive` table from the `HiveIpc` interface or assert at startup that every key of `HiveIpc` has both a preload binding and a dev-bridge RPC entry.

### 5. HIGH — Cancelled issues vanish without undo
**Where:** `BoardView.tsx:14,17` and `ListView.tsx:12,14` both default `showCancelled = false` and there is no UI to flip it.
**Symptom:** User changes an issue to `cancelled` and it disappears from the board AND list with no way to find or restore it short of CLI. Combined with no delete handler, "cancel" is effectively destructive.
**Fix:** Add a `showCancelled` toggle in `FilterBar.tsx` (or as a state-pill in the dropdown that's currently `STATE_ORDER`-filtered upstream) and pipe it down to BoardView/ListView. Also surface `cancelled` count somewhere visible (e.g., footer of board).

### 6. HIGH — `useCycles` is fetched but never rendered
**Where:** `queries.ts:53-59` defines `useCycles`. `grep` finds zero callers under `apps/desktop/src/renderer/`.
**Symptom:** Cycles are entirely invisible to the user even though the data layer fetches them. There is no cycle picker in IssuePeek, no cycle nav item in Sidebar, no cycle filter in FilterBar.
**Fix:** Add a Cycle row to IssuePeek's right rail (between Parent and Labels) using `useCycles`. Add a Cycle filter to `FilterBar`. Add a "Cycles" section to `Sidebar`.

### 7. MED — No keyboard shortcut for create
**Where:** `App.tsx` (only ⌘K handled via CommandPalette), `CommandPalette.tsx` (no "New issue" entry)
**Symptom:** Even after a Create button is added, power users can't ⌘N.
**Fix:** Add window-level ⌘N handler in `App.tsx` that opens a "new issue" modal; add a `Plus` CommandItem in `CommandPalette.tsx` under a new "Issue" group.

### 8. MED — Optimistic state update only patches `issues` list, not the open `issue` cache
**Where:** `queries.ts:72-77`
**Symptom:** Drag a card while the peek for that issue is open → board updates instantly, but the dropdown in IssuePeek still shows the OLD state until the refetch returns (`onSettled` invalidates `["issue", root, id]` but only after the mutation completes).
**Fix:** In `onMutate`, also `qc.setQueryData<Issue|null>(["issue", root, id], (old) => old ? { ...old, state } : old)`. Mirror the rollback in `onError`.

### 9. MED — `Sidebar` scope is permanently `{kind:"all"}`
**Where:** `App.tsx:29` initializes `scope`, line 41 hardcodes `const scopedIssues = issues;`, line 52 hardcodes `scopeLabel = "All issues"`. `SidebarScope` itself (`Sidebar.tsx:4`) is a union with one member.
**Symptom:** The `scope` state and the entire scope-narrowing UX is plumbed but unused — dead code path that confuses anyone reading App.tsx. Sidebar's only nav item is "All issues" and it just no-ops.
**Fix:** Either (a) actually implement scopes ("My issues", per-cycle, per-label, "Cancelled") and use `scope` to derive `scopedIssues`, or (b) delete the scope state + `SidebarScope` type until you need it.

### 10. LOW — Activity timestamps lose seconds, will display "Invalid Date"-ish behavior
**Where:** `storage.ts:407-411` formats `at` as `"YYYY-MM-DD HH:MM"` (no seconds, no TZ); `IssuePeek.tsx:258-267` `relTime` does `new Date(iso).getTime()` and only returns the ISO slice if `Number.isFinite(t)` is false. The activity entry format `"YYYY-MM-DD HH:MM"` is a valid `Date` ctor input in most engines but is parsed as LOCAL time, not UTC — so "now" can read as "8h ago" depending on timezone.
**Fix:** Store activity timestamps as full ISO with TZ (`new Date().toISOString()`), and adjust the regex in `parseActivity` (`storage.ts:381`) to match the new format.

### 11. LOW — `FilterBar` `toggleIn` and `ListView` `toggle` use comma-expression hacks that ignore lint
**Where:** `FilterBar.tsx:56-58`, `ListView.tsx:17-19` — `n.has(v) ? n.delete(v) : n.add(v)` discards the boolean return.
**Fix:** Cosmetic — change to an `if`. Not breaking, but it's the kind of "wat" line that triggers PR comments.

### 12. LOW — `IssuePeek` slide-over has no focus trap and no scroll lock
**Where:** `IssuePeek.tsx:34-43` — outer div is `pointer-events-none` with a backdrop, but background board still receives keyboard focus (Tab cycles into the kanban behind), and the page scrolls when wheel is over the backdrop.
**Fix:** Trap focus to the aside via `useEffect` setting tabindex / focus-trap-react; lock body scroll while open.

### 13. LOW — `CommandPalette` caps issue results at 25 hard
**Where:** `CommandPalette.tsx:98` `.slice(0, 25)`
**Symptom:** With >25 issues, users can't ⌘K to find #26+ by ID even with an exact match.
**Fix:** Filter by input query first (Command component already fuzzy-matches by `value` prop) before slicing, OR raise cap to 200 and let the underlying `cmdk` filter handle the rest.

## Quick wins (≤30 LOC each)

- **Show cancelled toggle** in FilterBar wired into BoardView/ListView's `showCancelled` prop (currently unreachable). Fixes finding #5.
- **Patch peek cache in `useUpdateState.onMutate`** so peek dropdown updates instantly. Finding #8.
- **Activity ISO timestamps** — `new Date().toISOString()` in `storage.ts:408`, update parse regex. Finding #10.
- **Sort issue results in CommandPalette by query relevance** and bump the slice cap. Finding #13.
- **Delete the unused `SidebarScope` plumbing** OR add at least an "Active work" scope. Finding #9.
- **Render Cycle PropRow in IssuePeek** (read-only display first) using existing `useCycles`. Half of finding #6.
- **Inline AC checkbox toggle** — change the `<span>` at IssuePeek.tsx:78-88 to a `<button>` that fires a (new) `useUpdateIssue` mutation patching `sections.acceptanceCriteria`. Depends on the IPC additions.

## Bigger lifts (>30 LOC)

- **Full create-issue pipeline** — new `createIssue` core helper, new IPC method through all 4 files (shared, main, preload, dev-bridge), `useCreateIssue` mutation, a NewIssueModal component with title/parent/labels/assignee/cycle fields, "+ New" button in App header + Board column footers, ⌘N keybind, palette entry. **~250 LOC across 8 files**. This is the single most important deficiency.
- **Generic `updateIssue(root, id, patch)`** — new core helper + IPC + mutation. Required to unblock title edit, body edit, label edit, assignee edit, cycle edit, AC toggle. **~150 LOC** plus matching UI controls.
- **IssuePeek edit mode** — replace static renders with form controls (title input, markdown textarea, label multiselect chip editor, assignee combobox, cycle dropdown, activity composer, delete button with confirm). **~300 LOC** in one file.
- **Members/agents picker** — new `listMembersAndAgents` IPC reading from `config.yaml`, plus a reusable `AssigneePicker` component. **~120 LOC**.
- **Cycle CRUD** — `createCycle` core/IPC/mutation + a CyclesView (currently nonexistent), or at minimum a "+ New cycle" affordance in the Cycle picker. **~180 LOC**.
- **Dev-bridge typesafety guard** — at startup, assert that every key of `HiveIpc` has a corresponding entry in both the `RPC` map AND the `window.hive` PREVIEW_SCRIPT string. **~30 LOC** but requires sharing the contract names between TS and the inline JS string (probably via codegen or a shared key array).
