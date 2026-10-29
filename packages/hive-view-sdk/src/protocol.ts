/**
 * Protocol v1 between the hivemind host (privileged renderer) and a community
 * view (sandboxed iframe), over ONE MessagePort. Every message is a plain JSON
 * object with a `type`. Both directions are validated by the functions below:
 * the host refuses anything malformed before it touches workspace state, the
 * client drops anything it does not understand.
 *
 * Shape follows the gaps the built-in World view found in the in-process view
 * contract (docs/design/workspace-views.md, phase 3 → 4): structure and names
 * are separate messages, colours arrive pre-resolved, status is a per-tile
 * subscription, selection says whether it is new since mount, and a live tile
 * surface is a hole the plugin punches (`surfaceRects`) that the host fills
 * with a real terminal above the iframe.
 */

import type { SettingValue } from "./settings.js";

export const PROTOCOL_VERSION = 1;

/** The values a client holds, each as it is before the host has sent it: what a copy of them kept
 *  elsewhere (a widget's worker) reads until the real ones arrive. Its keys are `CLIENT_VALUES`. */
export const CLIENT_VALUES_UNTIL_KNOWN = {
  hello: null, capabilities: [], viewport: { w: 0, h: 0 }, visible: true, device: { touch: false, compact: false }, settings: {}, features: [],
};

/** What a manifest may ask for beyond the base set (projection, status,
 *  selection, reveal, surfaces, layout). The host grants exactly what the
 *  manifest lists; an unknown name is refused at install and at load. */
/** `workspace:edit` (protocol 1.2): rename a tile, bind a frame to a folder.
 *  `workspace:prompt` (1.4): give an agent an instruction the view wrote; the user confirms each one.
 *  `workspace:sessions` (1.4): see past agent sessions in a frame's folder and continue one. */
export const VIEW_PERMISSIONS = ["workspace:spawn", "workspace:close", "workspace:edit", "workspace:prompt", "workspace:sessions", /** 1.8 */ "workspace:widgets", /** 1.9 */ "workspace:issues"] as const;
export type ViewPermission = (typeof VIEW_PERMISSIONS)[number];

/** What each permission lets a plugin do, in the words shown before it is installed (the app's
 *  review, HiveHub's page). */
const PERMISSION_WORDS: Record<ViewPermission, string> = {
  "workspace:spawn": "start agents in your workspace",
  "workspace:close": "close tiles",
  "workspace:edit": "rename tiles and point frames at folders",
  "workspace:prompt": "tell an agent something (you send or cancel each one)",
  "workspace:sessions": "see past agent sessions and continue one",
  // A widget's button can do what the widget may (start or close agents): pressing is asked for.
  "workspace:widgets": "press the workspace's widgets, as you would (what a widget does then, it does as you)",
  "workspace:issues": "read, create, change and delete the workspace's issues",
};
/** The permissions a plugin asks for, said as what they let it do; a name not known here is left out. */
export const permissionWords = (perms: readonly string[]): string[] =>
  perms.flatMap((p) => (Object.hasOwn(PERMISSION_WORDS, p) ? [PERMISSION_WORDS[p as ViewPermission]] : []));

export type ViewStatus = "unknown" | "idle" | "working" | "blocked" | "exited";
const STATUSES: readonly ViewStatus[] = ["unknown", "idle", "working", "blocked", "exited"];

/** What a status means, whatever the palette. A view paints `--hm-status-<tone>` (see
 *  `applyThemeVars`) and never decides for itself which colour "blocked" is — the host decides
 *  once, for the whole app, so a tile never means one thing in a view and another on the canvas. */
export type StatusTone = "working" | "attention" | "done" | "idle" | "exited" | "failed";
export const STATUS_TONES: readonly StatusTone[] = ["working", "attention", "done", "idle", "exited", "failed"];

/** The tone for a status. `done` and `failed` are never a live status: a view that observes a
 *  turn finishing may show `done`; `failed` is for an exit the host reports as a failure. */
export function statusTone(s: ViewStatus): StatusTone {
  switch (s) {
    case "blocked": return "attention";
    case "working": return "working";
    case "exited": return "exited";
    default: return "idle";
  }
}

/** Where a frame runs, when that is a saved machine (protocol 1.1, additive). `state` is the
 *  link: `online` (with `rttMs` once measured), `connecting`, `reconnecting`, `offline`,
 *  `attention` (a person must log in), `no-hive` (terminals there die with the connection). */
export interface ViewFrameMachine {
  name: string;
  state: "online" | "connecting" | "reconnecting" | "offline" | "attention" | "no-hive" | "idle";
  rttMs?: number;
}
/** The folder a frame is bound to (protocol 1.2, additive): a git `worktree` of its parent's repo, or
 *  a plain `folder` (a repository or not). `name` is its last path segment; the path itself stays
 *  with the host. A frame bound to nothing has no `folder`. */
export interface ViewFrameFolder { name: string; kind: "worktree" | "folder" }
export interface ViewFrame {
  id: string; title: string; /** `#rrggbb` */ color: string; machine?: ViewFrameMachine;
  /** 1.2: the frame this one is nested in (a worktree under its repo). */
  parentId?: string;
  /** 1.2: the git branch of a worktree frame. */
  branch?: string;
  folder?: ViewFrameFolder;
}
export interface ViewTile {
  id: string; frameId: string | null; kind: string; name: string;
  /** 1.2: which agent an agent tile runs — its catalog id (`"codex"`, `"claude"`, …). */
  agent?: string;
  /** 1.11: its mark as the app draws it, one `<svg>` element in `currentColor`; size it with CSS. */
  icon?: string;
  /** 1.14 (feature `sleep`): the agent is asleep. Its process ended; its tile keeps its last screen
   *  and its conversation until it is woken (`commands.wakeAgent`), and a prompt to it is refused
   *  `ASLEEP`. `since`: when it was put to sleep (ms since epoch), when the host knows. Absent while
   *  it is awake. */
  asleep?: { since?: number };
}
/** Agents driving agents (protocol 1.2): `pipes` carry one agent's replies into another's input;
 *  `spawns` record which agent opened which (`hive ctl spawn`). Tile ids at both ends. */
export interface ViewLinks { pipes: { src: string; dst: string }[]; spawns: { parent: string; child: string }[] }
export interface ViewRect { x: number; y: number; w: number; h: number }
/** `chrome` (protocol 1.1, additive): "bar" (default) lets the host draw its
 *  thin slot bar — name, status, pop-out, undock — on the surface; "none"
 *  leaves the whole rect to the surface (the plugin then owns undocking). */
export interface SurfaceRect extends ViewRect {
  tileId: string;
  chrome?: "bar" | "none";
  /** 1.13: its corners rounded by this many pixels (0 to 24), so the surface matches the card the view draws around it. */
  radius?: number;
  /** 1.13: the pointer passes through it to the view, while the view drags something across it. */
  inert?: true;
}
/** 1.17 (feature `lineSlots`): where the host draws a tile's last line, in px relative to the
 *  view's viewport: what its screen last showed or its agent last said, or, while its agent waits
 *  on the person, what for, with the host's own Allow and Deny when it can be answered. The view
 *  reserves the room and never gets the text. At least `LINE_SLOT_MIN_H` high; never inert. */
export interface LineRect extends ViewRect {
  tileId: string;
}
/** A command and the keys that run it (its manifest's `keys`). */
export interface CommandKeys { keys: string; command: string }
/** The roundest a surface's corners may be. */
export const MAX_SURFACE_RADIUS = 24;
/** The colours every host sends a view in `ViewTheme.colors`, each `#rrggbb`, which
 *  `applyThemeVars` sets as `--hm-color-<id>`. Frozen: a host may add one (and a view gives it a
 *  fallback), but removing or renaming one is a **Breaking:** change to the protocol. */
export const VIEW_THEME_COLORS = ["bg", "bg2", "bg3", "bg4", "fg", "fg2", "fg3", "line", "line2", "brand", "err", "ok", "warn", "info", "accent"] as const;
export type ViewThemeColor = (typeof VIEW_THEME_COLORS)[number];

/** The host theme, resolved. `colors` are the `--color-*` tokens as `#rrggbb`, every one of
 *  `VIEW_THEME_COLORS` at least;
 *  the rest (protocol 1.1, additive — a 1.0 host sends only `colors`) is the
 *  user's appearance: mode, accent, radius, fonts, the surface + terminal
 *  backgrounds, and whether glass is on. `applyThemeVars` maps all of it to
 *  CSS custom properties on the plugin document. */
export interface ViewTheme {
  colors: Record<string, string>;
  mode?: "dark" | "light";
  accent?: string;
  radius?: number;
  fonts?: { ui: string; mono: string };
  /** The panel surface colour (`#rrggbb`) and the terminal background. */
  surface?: string;
  terminalBackground?: string;
  glass?: boolean;
  /** Protocol 1.1, additive: one `#rrggbb` per status tone, resolved from the host's status
   *  tokens. A host that predates it sends none, and `applyThemeVars` derives them from `colors`. */
  status?: Partial<Record<StatusTone, string>>;
  /** 1.16 (feature `tokens`): the view's own tokens (its manifest's `tokens`), each resolved to
   *  `#rrggbb` for this theme and what the person set; `applyThemeVars` sets each as
   *  `--hm-token-<id>`. A host without the feature sends none: give each `var()` a fallback. */
  tokens?: Record<string, string>;
}

// ── protocol 1.3 (additive) ─────────────────────────────────────────────────

/** What a host implements beyond 1.2, sent in `hello.features`. A host that predates 1.3 sends
 *  none, so read the field (`hm.hello.features ?? []`), never probe for a client method. */
export const VIEW_FEATURES = ["since", "events", "activity", "presence", "history", "share", "agentStatus", "agents", "sessions", "prompt", /** 1.5 */ "participants", /** 1.6 */ "surfaces", /** 1.7 */ "settings", /** 1.8 */ "widgets", /** 1.9 */ "issues", /** 1.10 */ "invoke", /** 1.14 */ "sleep", /** 1.15 */ "hostMenu", /** 1.16 */ "tokens", /** 1.17 */ "fontFaces", "lineSlots", "ownFiles", /** 1.18 */ "widgetBand"] as const;
export type ViewFeature = (typeof VIEW_FEATURES)[number];

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

/** Why a tile needs the user. A category, never the text the agent showed. */
export type NeedsInputReason = "permission" | "question" | "review" | "approval" | "input";

// ── protocol 1.4 (additive) ─────────────────────────────────────────────────

/** What an agent session is doing, from the host's status store. */
export type ViewAgentState = "idle" | "working" | "waiting" | "done" | "failed" | "interrupted" | "limited" | "exited";
export const AGENT_STATES: readonly ViewAgentState[] = ["idle", "working", "waiting", "done", "failed", "interrupted", "limited", "exited"];
export type ViewWaitingFor = "permission" | "question" | "plan" | "approval" | "other";
export type TurnOutcome = "done" | "failed" | "interrupted" | "limited";

/** Fixed words and counts: never a subagent's name or anything an agent wrote. */
export interface ViewAgentStatus {
  state: ViewAgentState;
  waitingFor?: ViewWaitingFor;
  subagents: number;
  /** Shells the last turn left running. */
  background: number;
  compacting: boolean;
  /** "hooks": the agent reports it; "screen": read from its screen, so coarser. */
  source?: "hooks" | "screen";
}

/** An agent this machine can start, and what it supports. */
export interface ViewAgent {
  id: string;
  label: string;
  /** The user's default agent. */
  default: boolean;
  /** Reports when its turns end (so `turn` events are exact). */
  turns: boolean;
  /** Can continue a past session. */
  resumes: boolean;
  /** Its past sessions can be listed. */
  sessions: boolean;
}

/** A past session in a frame's folder. `prompt`: the first line of the user's first prompt. */
export interface ViewSession { id: string; updated?: number; prompt?: string }

export type PromptOutcome = "sent" | "cancelled";

/** Discrete facts about the workspace. Ids, kinds, counts and times — no text an agent wrote. */
export type ViewEvent =
  /** `inferred`: the agent has no turn hook, so this is a working → idle transition. */
  | { kind: "turn"; seq: number; at: number; tileId: string; inferred?: boolean; /** 1.4 */ outcome?: TurnOutcome }
  | { kind: "needsInput"; seq: number; at: number; tileId: string; reason: NeedsInputReason }
  | { kind: "subagents"; seq: number; at: number; tileId: string; active: number }
  | { kind: "tileOpened"; seq: number; at: number; tileId: string; frameId: string | null; tileKind: string; agent?: string; spawnedBy?: string }
  /** `failed`: the process exited non-zero. */
  | { kind: "tileClosed"; seq: number; at: number; tileId: string; lastStatus: ViewStatus; failed?: boolean }
  /** From `hive ctl view emit`. `from` is the emitter's own claim; treat `data` as untrusted text. */
  | { kind: "custom"; seq: number; at: number; id: string; name: string; data: JsonValue; from: "shell" | { tileId: string } };
export type ViewEventKind = ViewEvent["kind"];
export const EVENT_KINDS: readonly ViewEventKind[] = ["turn", "needsInput", "subagents", "tileOpened", "tileClosed", "custom"];

/** 0 quiet · 1 trickle · 2 steady · 3 heavy — a level, never a byte count. */
export type ActivityLevel = 0 | 1 | 2 | 3;

export interface ViewPresence {
  state: "active" | "idle" | "away";
  /** epoch ms the state began */
  since: number;
  /** the app window has focus (the user may be active in another app) */
  focused: boolean;
}

export interface ViewHistoryTile {
  id: string; frameId: string | null; tileKind: string; agent?: string;
  /** last known name */
  name: string;
  openedAt?: number; closedAt?: number;
  /** [start, end, status], clipped to the day */
  intervals: [number, number, ViewStatus][];
  /** turn-finished times: a turn hook's, and those inferred for an agent without one */
  turns: number[];
}
export interface ViewHistoryDay {
  day: string;
  /** epoch ms of the day's local midnight and the next */
  from: number; to: number;
  /** every tile that existed during the day in this workspace, closed ones included */
  tiles: ViewHistoryTile[];
  /** titles of frames referenced above: id → title */
  frames: Record<string, string>;
  /** seconds in each state that day while the app ran — totals only */
  presence: { active: number; idle: number; away: number };
  /** spans the host did not watch: the app was not running, or (per tile) its machine was not online */
  gaps: { from: number; to: number; tileId?: string }[];
}

/** `ASLEEP` (1.14): the agent asked of is asleep; wake it first (`commands.wakeAgent`). */
export type RequestErrorCode = "UNSUPPORTED" | "BAD_REQUEST" | "BUSY" | "DECLINED" | "INTERNAL" | "ASLEEP";
export type ShareOutcome = "copied" | "saved" | "cancelled";

// ── protocol 1.10 (additive) ────────────────────────────────────────────────
// `invoke` in `hello.features`: the host runs one of the commands the plugin's manifest declares
// (`invoke`: an agent's `hive ctl plugin call`), and the plugin answers it once (`invokeResult`):
// what its handler returned, or why it failed. `hm.onCommand` does both.

/** The most an invoked command's argument, and its answer, may take as JSON. */
export const INVOKE_ARGS_MAX = 64 * 1024;
export const INVOKE_RESULT_MAX = 256 * 1024;

// ── protocol 1.9 (additive) ─────────────────────────────────────────────────
// `issues` in `hello.features`: after `subscribeIssues` the view is sent the workspace's issues
// (`issues`), again whenever one changes, and may call the workspace's issue methods (`issue`
// requests). All of it needs `workspace:issues`. The workspace is the one the view shows (a tool's
// tile: its frame's); the host names it, never the view. Only `read` reaches an issue of another of
// the host's workspaces (a link's other end, found by its prefix); every write is to this one.

export const ISSUE_STATES = ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"] as const;
export type ViewIssueState = (typeof ISSUE_STATES)[number];
export interface ViewIssueAssignee { type: "agent" | "member"; id: string; model?: string }
/** An issue as a list shows it. */
export interface ViewIssueSummary {
  id: string;
  title: string;
  state: ViewIssueState;
  parent: string | null;
  labels: string[];
  assignee: ViewIssueAssignee | null;
  github?: number | null;
  created: string;
  updated: string;
}
/** An issue in full: its description, acceptance criteria and activity. */
export interface ViewIssue extends ViewIssueSummary {
  links?: { id: string; type: string }[];
  sections: {
    description: string;
    acceptanceCriteria: { done: boolean; text: string }[];
    activity: { at: string; who: string; message: string }[];
  };
}
/** The issue calls a view can make. */
export const ISSUE_CALLS = ["read", "create", "update", "setState", "comment", "delete", "link", "unlink", "move", "workspaces", /** 1.12 */ "status", "setUp"] as const;
export type IssueCall = (typeof ISSUE_CALLS)[number];
/** The most an `issue` request's arguments may take, as JSON. */
export const ISSUE_ARGS_MAX = 256 * 1024;

// ── protocol 1.8 (additive) ─────────────────────────────────────────────────
// `widgets` in `hello.features`: after `subscribeWidgets` the view is sent every widget in the
// workspace (`widgets`), again whenever one changes, and with the permission `workspace:widgets`
// may press one (`pressWidget`), as a person pressing it where it is drawn: a widget's button can
// do whatever the widget may, so pressing is asked for at install. A phone shows widgets through
// a view that does this.

/** A widget in the workspace, as a view is given it (feature `widgets`). */
export interface ViewWidget {
  /** The widget placed in the workspace, and the package it is. */
  id: string;
  widget: string;
  name: string;
  /** What it draws, in the app's drawing nodes (stack, row, text, number, meter, button, image,
   *  sprite, input, textarea, list); null until its code has drawn. */
  tree: unknown;
  /** It sits on a card; false for one drawn bare (a pet, a text label). */
  card: boolean;
  /** A note colour its card is tinted (`yellow`, `pink`, …). */
  tint?: string;
  /** What people wrote in it: an input's or textarea's text, a list's lines. */
  text?: string;
  items?: Array<{ id: string; text: string; done: boolean }>;
  /** The images its tree names, by file name, as data URLs. */
  images: Record<string, string>;
  placement: "board" | "screen";
}

// ── protocol 1.18 (additive) ────────────────────────────────────────────────
// `widgetBand` in `hello.features`: the app floats widget cards over the view, stacked down the
// view's widget edge (its manifest's `"widgets"`, else the right), and says how much of the view
// they take (`widgetBand`): right after `hello`, and again whenever cards come or go, stack into
// another column, or the window is resized. A view keeps what it must show out of that band. A
// computer's window says it, a guest's over the host's view too; a phone floats no cards over a
// view and does not say it.

/** The band of widget cards over a view (feature `widgetBand`): `width` CSS px in from the view's
 *  `edge` to the far side of the cards, the gap beside them included; 0 when there are none. */
export interface ViewWidgetBand { edge: "left" | "right"; width: number }

// ── protocol 1.17 (additive) ────────────────────────────────────────────────
// `lineSlots` in `hello.features`: this host draws each tile's last line in the rects a view
// reserves for them (`lineRects`), and for a wait what the agent waits on with the host's own Allow
// and Deny. No text an agent or a terminal wrote crosses to the view: it gets the room, not the
// line. A desktop window draws them; a phone's or a remote screen's host does not say it.

// ── protocol 1.7 (additive) ─────────────────────────────────────────────────
// `settings` in `hello.features`: `hello.settings` holds the value of every field the manifest
// declares (the person's, else the field's default), and a `settings` message carries them all
// again whenever the person changes one. A host before 1.7 sends neither: `hm.settings` is then
// empty, so a view reads each value with its own default beside it.

// ── protocol 1.6 (additive) ─────────────────────────────────────────────────
// `surfaces` in `hello.features`: this host places the live surfaces a view asks for with
// `surfaceRects` (a tile's terminal in the hole the view leaves). A desktop window places them; a
// phone's app does over the view's web view, when it says so. A host before 1.6 does not say it:
// every such host is a desktop window, which places them.

// ── protocol 1.5 (additive) ─────────────────────────────────────────────────

/** What the view is shown on, in `hello.device`: `touch`, the pointer is a finger, so what it
 *  taps needs room; `compact`, a phone's screen, so one column. A host that predates 1.5 sends
 *  none: read `hm.device`, which is then a desktop's. */
export interface ViewDevice { touch: boolean; compact: boolean }

/** Someone else in the workspace, after `subscribeParticipants` (feature `participants`): another
 *  person, or this person at another device. Never the person at this view. */
export interface ViewParticipant {
  /** Theirs while they are here: one per window or device. */
  id: string;
  /** Their person, the same at each of their devices: one face per person. */
  person: string;
  name: string;
  /** `#rrggbb`: the colour the app draws them in. */
  color: string;
  /** The tile their pointer is over, when it is one of this view's. */
  cursor: { tileId: string } | null;
  /** What they have selected of this view's tiles and frames. */
  selection: string[];
}

// ── host → plugin ───────────────────────────────────────────────────────────

/** 1.17 (feature `fontFaces`): one file of a font a theme brought, as its bytes (woff2, base64).
 *  A view's frame cannot fetch the app's files, but a face made from bytes loads in it
 *  (`new FontFace(family, bytes)`); the client SDK adds each to the view's `document.fonts`, so the
 *  family `theme.fonts` names draws in it. Sent in `hello` and in `fonts` when they change, never
 *  in `theme`, which is sent on every slider move. */
export interface ViewFontFace { family: string; data: string; weight?: string; style?: string }
/** The most faces, and the most base64 characters of one, a host sends (4 files of 400 KB for each
 *  of the two faces a theme may set). */
export const MAX_VIEW_FONT_FACES = 8;
export const MAX_VIEW_FONT_DATA = 560_000;

export type HostMessage =
  | { type: "hello"; v: number; pluginId: string; capabilities: ViewPermission[]; theme: ViewTheme; layout: unknown; viewport: { w: number; h: number }; visible: boolean; /** 1.3 */ features?: ViewFeature[]; /** 1.5 */ device?: ViewDevice; /** 1.7 */ settings?: Record<string, SettingValue>; /** 1.13: the declared commands' keys, run in the plugin's frame */ keys?: CommandKeys[]; /** 1.17 */ fontFaces?: ViewFontFace[] }
  /** 1.17: the theme's font faces changed (none: the theme has no font files). */
  | { type: "fonts"; fontFaces: ViewFontFace[] }
  /** Frames / tiles / membership (+ the current names). Structural only. */
  | { type: "structure"; frames: ViewFrame[]; tiles: ViewTile[]; /** 1.2 */ links?: ViewLinks }
  /** Display names changed (renames, agent titles) — nothing structural did. */
  | { type: "names"; names: Record<string, string> }
  /** `fresh` = changed since the plugin mounted (the selection you arrive with is not fresh). */
  | { type: "selection"; tileId: string | null; frameId: string | null; fresh: boolean }
  /** 1.3: `since` is when the tile entered this status; `exact: false` means the host found it
   *  already there, so `since` is a lower bound. */
  | { type: "status"; tileId: string; status: ViewStatus; since?: number; exact?: boolean; /** 1.4, agent tiles */ agent?: ViewAgentStatus }
  /** 1.3, after `subscribeEvents`: batched, oldest first. `replay` = from the host's buffer. */
  | { type: "events"; events: ViewEvent[]; replay?: boolean }
  /** 1.3, after `watchActivity`: only tiles whose level changed, at most 4 per second. */
  | { type: "activity"; levels: Record<string, ActivityLevel> }
  /** 1.3, after `subscribePresence`: on change. */
  | { type: "presence"; presence: ViewPresence }
  /** 1.5, after `subscribeParticipants`: everyone else here, whenever who, their pointer's tile or
   *  their selection changes. */
  | { type: "participants"; participants: ViewParticipant[] }
  /** 1.3: the answer to a `request`. */
  | { type: "response"; requestId: number; ok: true; result: unknown }
  | { type: "response"; requestId: number; ok: false; error: { code: RequestErrorCode; message: string } }
  /** "Show me this tile"; answer with `revealed` (its rect, or null). */
  | { type: "reveal"; requestId: number; tileId: string }
  | { type: "resize"; w: number; h: number }
  | { type: "visibility"; visible: boolean }
  | { type: "theme"; theme: ViewTheme }
  /** 1.7: every declared setting's value, after the person changed one. */
  | { type: "settings"; settings: Record<string, SettingValue> }
  /** 1.8, after `subscribeWidgets`: every widget in the workspace, whenever one changes. */
  | { type: "widgets"; widgets: ViewWidget[] }
  /** 1.9, after `subscribeIssues`: the workspace's issues, whenever one changes. */
  | { type: "issues"; issues: ViewIssueSummary[] }
  /** The user undocked a surface from the host's bar (or Shift+Esc): the
   *  host has already released the tile; drop the rect on your side. */
  | { type: "undock"; tileId: string }
  /** 1.10: run the declared command `name`; answer with one `invokeResult` of the same id. */
  | { type: "invoke"; invokeId: number; name: string; args: unknown }
  /** 1.18 (feature `widgetBand`): how much of the view the app's widget cards take, from its widget
   *  edge (`ViewWidgetBand`). Sent right after `hello`, then on every change. */
  | { type: "widgetBand"; edge: "left" | "right"; width: number };

// ── plugin → host ───────────────────────────────────────────────────────────

/** The WorkspaceCommands vocabulary a plugin may invoke, with the argument
 *  shapes the host accepts. `spawnTile`'s free-form options are deliberately
 *  not exposed (an agent command line is not something a plugin chooses). */
export interface ViewCommands {
  selectTile: (id: string | null) => void;
  selectFrame: (id: string | null) => void;
  focusTile: (id: string, opts?: { exact?: boolean }) => void;
  /** permission `workspace:close` */
  closeTile: (id: string) => void;
  /** permission `workspace:spawn` */
  spawnTile: (kind: string, frameId: string | null) => void;
  /** permission `workspace:spawn` */
  spawnVis: (which: "tree" | "shell" | "issues") => void;
  /** permission `workspace:spawn` */
  spawnClaude: () => void;
  /** permission `workspace:spawn` */
  addFrame: () => void;
  /** 1.2, permission `workspace:spawn`: start an agent — a catalog id, or null for the user's
   *  default — in a frame (null: the host picks), optionally with a tile name. 1.4: a `prompt`
   *  also needs `workspace:prompt` and the user's confirm; `resume` (a session id from
   *  `sessions`) also needs `workspace:sessions`. */
  spawnAgent: (agent: string | null, frameId: string | null, opts?: { prompt?: string; name?: string; resume?: string }) => void;
  /** 1.2, permission `workspace:edit`: rename a tile ("" goes back to its own name). */
  renameTile: (id: string, name: string) => void;
  /** 1.2, permission `workspace:edit`: ask the user for a folder to bind this frame to. */
  openFolder: (frameId: string) => void;
  /** 1.14, permission `workspace:spawn`: wake the agent asleep in a tile, in its conversation. */
  wakeAgent: (tileId: string) => void;
  /** 1.14, permission `workspace:spawn`: put the agent in a tile to sleep. One working or waiting on
   *  someone is put to sleep only if the person says so. */
  sleepAgent: (tileId: string) => void;
  /** 1.15 (feature `hostMenu`), no permission: open one of the app's own menus, as its toolbar does,
   *  for a view that draws a toolbar of its own (`"toolbar": "off"`). `views` lists the views to
   *  switch to, beside `at` (where the view's button is, in its own pixels); `add` opens Add, for a
   *  widget or a tool; `appearance` the theme panel; `settings` the app's Settings. The person
   *  chooses in it: nothing changes until they do. */
  openHostMenu: (menu: HostMenu, at?: ViewRect) => void;
}
/** The app menus a view may open (`commands.openHostMenu`, 1.15). */
export const HOST_MENUS = ["views", "add", "appearance", "settings"] as const;
export type HostMenu = (typeof HOST_MENUS)[number];
export type CommandName = keyof ViewCommands;
export const COMMAND_PERMISSION: Record<CommandName, ViewPermission | null> = {
  selectTile: null, selectFrame: null, focusTile: null,
  closeTile: "workspace:close",
  spawnTile: "workspace:spawn", spawnVis: "workspace:spawn", spawnClaude: "workspace:spawn", addFrame: "workspace:spawn",
  spawnAgent: "workspace:spawn", renameTile: "workspace:edit", openFolder: "workspace:edit",
  wakeAgent: "workspace:spawn", sleepAgent: "workspace:spawn", openHostMenu: null,
};

export type PluginMessage =
  | { type: "ready"; v: number }
  | { type: "command"; name: CommandName; args: unknown[] }
  | { type: "subscribeStatus"; tileId: string }
  | { type: "unsubscribeStatus"; tileId: string }
  /** The hole-punch: where live tile surfaces belong, in px relative to the
   *  plugin's viewport. The host positions a real slot per rect above the iframe. */
  | { type: "surfaceRects"; rects: SurfaceRect[] }
  /** 1.17 (feature `lineSlots`): where the host draws each tile's last line (`LineRect`), in place
   *  of those asked for before; `[]` draws none. A host without the feature counts it against the
   *  view, so send it only when `supports("lineSlots")`. */
  | { type: "lineRects"; rects: LineRect[] }
  | { type: "revealed"; requestId: number; rect: ViewRect | null }
  /** Frames the plugin has drawn so far (monotonic). The host reads it for its
   *  render-on-demand checks; send it when it changes, at most ~1/s. */
  | { type: "framesDrawn"; count: number }
  /** Persist an opaque blob under the plugin id (≤ LAYOUT_MAX_BYTES). */
  | { type: "layout"; data: unknown }
  | { type: "error"; message: string }
  /** 1.3: replaces any earlier subscription. `custom` names may end in ".*" to match a prefix. */
  | { type: "subscribeEvents"; kinds: ViewEventKind[]; custom?: string[]; replaySince?: number }
  | { type: "unsubscribeEvents" }
  /** 1.3: the whole watched set, replaced each time. */
  | { type: "watchActivity"; tileIds: string[] }
  | { type: "subscribePresence" }
  | { type: "unsubscribePresence" }
  /** 1.5 */
  | { type: "subscribeParticipants" }
  | { type: "unsubscribeParticipants" }
  /** 1.8 */
  | { type: "subscribeWidgets" }
  | { type: "unsubscribeWidgets" }
  /** 1.9 */
  | { type: "subscribeIssues" }
  | { type: "unsubscribeIssues" }
  /** 1.10: the answer to an `invoke`. */
  | { type: "invokeResult"; invokeId: number; ok: true; result: unknown }
  | { type: "invokeResult"; invokeId: number; ok: false; error: string }
  /** 1.8: press one of a widget's buttons (its `action`), or its card (`click`). */
  | { type: "pressWidget"; id: string; action?: unknown; click?: true }
  /** 1.3: answered by one `response` with the same id. The share buffer is the one non-JSON value. */
  | { type: "request"; requestId: number; name: "history"; args: [{ day: string }] }
  | { type: "request"; requestId: number; name: "share"; args: [{ png: ArrayBuffer; suggestedName?: string }] }
  /** 1.4: result `{ agents: ViewAgent[] }`. */
  | { type: "request"; requestId: number; name: "agents"; args: [Record<string, never>] }
  /** 1.4, `workspace:sessions`: result `{ sessions: ViewSession[] }`, newest first. */
  | { type: "request"; requestId: number; name: "sessions"; args: [{ agent: string; frameId: string }] }
  /** 1.4, `workspace:prompt`: result `{ outcome: PromptOutcome }` once the user chose. 1.14: a tile
   *  asleep is refused `ASLEEP` before the user is asked, as `hive ctl send` refuses it. */
  | { type: "request"; requestId: number; name: "prompt"; args: [{ tileId: string; text: string }] }
  /** 1.9: one of the workspace's issue methods; a writing one needs `workspace:issues`. Result: what it returns. */
  | { type: "request"; requestId: number; name: "issue"; args: [{ call: IssueCall; args: unknown[] }] };

export const MAX_SURFACE_RECTS = 16;
/** 1.17: the most line slots a view asks for at once, and the least height of one. */
export const MAX_LINE_RECTS = 64;
export const LINE_SLOT_MIN_H = 20;
/** 1.2 argument caps: a tile name, and an agent's first prompt. */
export const NAME_MAX = 120;
export const PROMPT_MAX = 32 * 1024;
export const LAYOUT_MAX_BYTES = 64 * 1024;
/** 1.3 limits. */
export const ACTIVITY_MAX_TILES = 256;
export const ACTIVITY_MIN_INTERVAL_MS = 250;
export const CUSTOM_NAME_MAX = 64;
export const CUSTOM_DATA_MAX_BYTES = 4096;
export const CUSTOM_DATA_MAX_DEPTH = 8;
export const CUSTOM_PATTERNS_MAX = 32;
export const EVENT_REPLAY_MAX = 100;
export const SHARE_MAX_BYTES = 8 * 1024 * 1024;
export const SHARE_MAX_SIDE = 4096;
const ID_MAX = 256;

const CUSTOM_NAME_RE = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/;
const RESERVED_PREFIXES = ["hive.", "hm."];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const SUGGESTED_NAME_RE = /^[\w .-]{1,64}$/;
/** A session id as the host puts it on a command line. */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** Keystrokes and hidden text: C0/C1 controls but tab and newline, bidi controls, zero-width. */
const UNSAFE_PROMPT_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;

/** Characters a reason must not carry as they are: controls, bidi and zero-width ones, line breaks. */
const UNSAFE_QUOTED = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/** Something a plugin sent, quoted for a reason a person may read (a refusal, a notice that it was
 *  turned off): at most `max` characters, its controls and bidi characters escaped. */
export function quoted(v: unknown, max = 40): string {
  const s = String(v);
  const cut = s.length > max ? `${s.slice(0, max).replace(/[\ud800-\udbff]$/, "")}…` : s;
  return `"${cut.replace(/["\\]/g, "\\$&").replace(UNSAFE_QUOTED, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}"`;
}

/** Why a prompt a view wrote is refused, or null. The app types it into a terminal, so a control
 *  character is a keystroke, and hidden characters would keep it from the user's confirm. */
export function promptProblem(text: unknown): string | null {
  if (typeof text !== "string" || !text.trim()) return "text must be a non-empty string";
  if (text.length > PROMPT_MAX) return `text exceeds ${PROMPT_MAX} characters`;
  if (UNSAFE_PROMPT_RE.test(text)) return "text carries control, bidi or zero-width characters";
  return null;
}

/** A `hive ctl view emit` name: dotted lowercase words, ≤ 64, not under a reserved prefix. */
export function isCustomEventName(name: unknown): name is string {
  return typeof name === "string" && name.length <= CUSTOM_NAME_MAX && CUSTOM_NAME_RE.test(name)
    && !RESERVED_PREFIXES.some((p) => name.startsWith(p));
}

/** A subscription pattern: an event name, or one followed by ".*" for everything under it. */
export function isCustomPattern(p: unknown): p is string {
  if (typeof p !== "string") return false;
  const base = p.endsWith(".*") ? p.slice(0, -2) : p;
  return base.length > 0 && base.length <= CUSTOM_NAME_MAX && CUSTOM_NAME_RE.test(base);
}

export function customNameMatches(patterns: readonly string[], name: string): boolean {
  return patterns.some((p) => (p.endsWith(".*") ? name.startsWith(p.slice(0, -1)) : p === name));
}

/** Why a custom event payload is refused, or null when it is acceptable JSON within the limits. */
export function customDataProblem(data: unknown): string | null {
  const depthOk = (v: unknown, d: number): boolean => {
    if (d > CUSTOM_DATA_MAX_DEPTH) return false;
    if (Array.isArray(v)) return v.every((x) => depthOk(x, d + 1));
    if (v && typeof v === "object") return Object.values(v).every((x) => depthOk(x, d + 1));
    return true;
  };
  const plain = (v: unknown): boolean => {
    if (v === null || typeof v === "string" || typeof v === "boolean") return true;
    if (typeof v === "number") return Number.isFinite(v);
    if (Array.isArray(v)) return v.every(plain);
    if (typeof v === "object") return Object.getPrototypeOf(v) === Object.prototype && Object.values(v as object).every(plain);
    return false;
  };
  if (!plain(data)) return "data must be plain JSON";
  if (!depthOk(data, 1)) return `data is nested deeper than ${CUSTOM_DATA_MAX_DEPTH}`;
  if (new TextEncoder().encode(JSON.stringify(data)).length > CUSTOM_DATA_MAX_BYTES) return `data exceeds ${CUSTOM_DATA_MAX_BYTES} bytes`;
  return null;
}

/** Whether a day string is a real calendar date. */
export function isDay(day: unknown): day is string {
  if (typeof day !== "string" || !DAY_RE.test(day)) return false;
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

// ── validation ──────────────────────────────────────────────────────────────

export type ParseResult<T> = { ok: true; msg: T } | { ok: false; reason: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= ID_MAX;
const isIdOrNull = (v: unknown): v is string | null => v === null || isId(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isRect = (v: unknown): v is ViewRect => isObj(v) && isNum(v.x) && isNum(v.y) && isNum(v.w) && isNum(v.h);
const isParticipant = (v: unknown): v is ViewParticipant => isObj(v) && isId(v.id) && isId(v.person)
  && typeof v.name === "string" && typeof v.color === "string"
  && (v.cursor === null || (isObj(v.cursor) && isId(v.cursor.tileId)))
  && Array.isArray(v.selection) && v.selection.every(isId);

const COMMAND_ARGS: Record<CommandName, (args: unknown[]) => boolean> = {
  selectTile: (a) => a.length === 1 && isIdOrNull(a[0]),
  selectFrame: (a) => a.length === 1 && isIdOrNull(a[0]),
  focusTile: (a) => (a.length === 1 || a.length === 2) && isId(a[0]) && (a[1] === undefined || (isObj(a[1]) && (a[1].exact === undefined || typeof a[1].exact === "boolean"))),
  closeTile: (a) => a.length === 1 && isId(a[0]),
  spawnTile: (a) => a.length === 2 && isId(a[0]) && isIdOrNull(a[1]),
  spawnVis: (a) => a.length === 1 && ["tree", "shell", "issues"].includes(a[0] as string),
  spawnClaude: (a) => a.length === 0,
  addFrame: (a) => a.length === 0,
  spawnAgent: (a) => (a.length >= 2 && a.length <= 3) && (a[0] === null || isId(a[0])) && isIdOrNull(a[1])
    && (a[2] === undefined || (isObj(a[2])
      && (a[2].prompt === undefined || promptProblem(a[2].prompt) === null)
      && (a[2].name === undefined || (typeof a[2].name === "string" && a[2].name.length <= NAME_MAX))
      && (a[2].resume === undefined || (typeof a[2].resume === "string" && SESSION_ID_RE.test(a[2].resume))))),
  renameTile: (a) => a.length === 2 && isId(a[0]) && typeof a[1] === "string" && a[1].length <= NAME_MAX,
  openFolder: (a) => a.length === 1 && isId(a[0]),
  wakeAgent: (a) => a.length === 1 && isId(a[0]),
  sleepAgent: (a) => a.length === 1 && isId(a[0]),
  openHostMenu: (a) => (a.length === 1 || (a.length === 2 && isRect(a[1]))) && (HOST_MENUS as readonly unknown[]).includes(a[0]),
};

/** Host side: validate a message received from a plugin. */
export function parsePluginMessage(raw: unknown): ParseResult<PluginMessage> {
  if (!isObj(raw) || typeof raw.type !== "string") return { ok: false, reason: "not an object with a string type" };
  const bad = (why: string): ParseResult<PluginMessage> => ({ ok: false, reason: `${raw.type}: ${why}` });
  switch (raw.type) {
    case "ready":
      return isNum(raw.v) ? { ok: true, msg: { type: "ready", v: raw.v } } : bad("v must be a number");
    case "command": {
      const name = raw.name as CommandName;
      const check = Object.prototype.hasOwnProperty.call(COMMAND_ARGS, name) ? COMMAND_ARGS[name] : null;
      if (!check) return bad(`unknown command ${JSON.stringify(raw.name)}`);
      const args = raw.args === undefined ? [] : raw.args;
      if (!Array.isArray(args) || !check(args)) return bad(`bad arguments for ${name}`);
      return { ok: true, msg: { type: "command", name, args } };
    }
    case "subscribeStatus":
    case "unsubscribeStatus":
      return isId(raw.tileId) ? { ok: true, msg: { type: raw.type, tileId: raw.tileId } } : bad("tileId must be a string");
    case "surfaceRects": {
      if (!Array.isArray(raw.rects)) return bad("rects must be an array");
      if (raw.rects.length > MAX_SURFACE_RECTS) return bad(`more than ${MAX_SURFACE_RECTS} rects`);
      const seen = new Set<string>();
      for (const r of raw.rects) {
        if (!isRect(r) || !isId((r as SurfaceRect).tileId)) return bad("each rect needs tileId,x,y,w,h numbers");
        if (seen.has((r as SurfaceRect).tileId)) return bad("duplicate tileId");
        seen.add((r as SurfaceRect).tileId);
        const c = (r as SurfaceRect).chrome;
        if (c !== undefined && c !== "bar" && c !== "none") return bad("chrome must be \"bar\" or \"none\"");
        const radius = (r as SurfaceRect).radius;
        if (radius !== undefined && !(typeof radius === "number" && radius >= 0 && radius <= MAX_SURFACE_RADIUS)) return bad(`radius must be a number from 0 to ${MAX_SURFACE_RADIUS}`);
        const inert = (r as SurfaceRect).inert;
        if (inert !== undefined && inert !== true) return bad("inert must be true when it is given");
      }
      return { ok: true, msg: { type: "surfaceRects", rects: (raw.rects as SurfaceRect[]).map((r) => ({ tileId: r.tileId, x: r.x, y: r.y, w: r.w, h: r.h, ...(r.chrome ? { chrome: r.chrome } : {}), ...(r.radius ? { radius: r.radius } : {}), ...(r.inert ? { inert: true as const } : {}) })) } };
    }
    case "lineRects": {
      if (!Array.isArray(raw.rects)) return bad("rects must be an array");
      if (raw.rects.length > MAX_LINE_RECTS) return bad(`more than ${MAX_LINE_RECTS} rects`);
      const seen = new Set<string>();
      for (const r of raw.rects) {
        if (!isRect(r) || !isId((r as LineRect).tileId)) return bad("each rect needs tileId,x,y,w,h numbers");
        if (seen.has((r as LineRect).tileId)) return bad("duplicate tileId");
        seen.add((r as LineRect).tileId);
        if ((r as LineRect).h < LINE_SLOT_MIN_H) return bad(`each rect is at least ${LINE_SLOT_MIN_H}px high`);
      }
      // Only what a slot is: anything else a view adds (`inert`) is dropped.
      return { ok: true, msg: { type: "lineRects", rects: (raw.rects as LineRect[]).map((r) => ({ tileId: r.tileId, x: r.x, y: r.y, w: r.w, h: r.h })) } };
    }
    case "revealed":
      if (!isNum(raw.requestId)) return bad("requestId must be a number");
      if (raw.rect !== null && !isRect(raw.rect)) return bad("rect must be a rect or null");
      return { ok: true, msg: { type: "revealed", requestId: raw.requestId, rect: raw.rect === null ? null : { x: raw.rect.x, y: raw.rect.y, w: raw.rect.w, h: raw.rect.h } } };
    case "framesDrawn":
      return isNum(raw.count) && raw.count >= 0 ? { ok: true, msg: { type: "framesDrawn", count: raw.count } } : bad("count must be a non-negative number");
    case "layout": {
      let size = 0;
      try { size = JSON.stringify(raw.data ?? null).length; } catch { return bad("data is not JSON"); }
      if (size > LAYOUT_MAX_BYTES) return bad(`data exceeds ${LAYOUT_MAX_BYTES} bytes`);
      return { ok: true, msg: { type: "layout", data: raw.data ?? null } };
    }
    case "error":
      return typeof raw.message === "string" ? { ok: true, msg: { type: "error", message: raw.message.slice(0, 2000) } } : bad("message must be a string");
    case "subscribeEvents": {
      if (!Array.isArray(raw.kinds) || raw.kinds.length > EVENT_KINDS.length || !raw.kinds.every((k) => EVENT_KINDS.includes(k as ViewEventKind))) return bad("kinds must be event kinds");
      const custom = raw.custom === undefined ? undefined : raw.custom;
      if (custom !== undefined && (!Array.isArray(custom) || custom.length > CUSTOM_PATTERNS_MAX || !custom.every(isCustomPattern))) return bad(`custom must be at most ${CUSTOM_PATTERNS_MAX} event names or name.* patterns`);
      if (raw.replaySince !== undefined && !isNum(raw.replaySince)) return bad("replaySince must be a number");
      return { ok: true, msg: {
        type: "subscribeEvents", kinds: [...new Set(raw.kinds as ViewEventKind[])],
        ...(custom ? { custom: [...new Set(custom as string[])] } : {}),
        ...(raw.replaySince !== undefined ? { replaySince: raw.replaySince as number } : {}),
      } };
    }
    case "unsubscribeEvents":
    case "subscribePresence":
    case "unsubscribePresence":
    case "subscribeParticipants":
    case "unsubscribeParticipants":
    case "subscribeWidgets":
    case "unsubscribeWidgets":
    case "subscribeIssues":
    case "unsubscribeIssues":
      return { ok: true, msg: { type: raw.type } };
    case "pressWidget": {
      if (!isId(raw.id)) return bad("id must be a widget id");
      let size = Infinity;
      try { size = JSON.stringify(raw.action ?? null).length; } catch { /* not JSON */ }
      if (raw.click === true) return { ok: true, msg: { type: "pressWidget", id: raw.id as string, click: true } };
      return size <= 1024 ? { ok: true, msg: { type: "pressWidget", id: raw.id as string, action: raw.action } } : bad("action must be JSON of at most 1 KB");
    }
    case "invokeResult": {
      if (!isNum(raw.invokeId)) return bad("invokeId must be a number");
      if (raw.ok === false) return { ok: true, msg: { type: "invokeResult", invokeId: raw.invokeId, ok: false, error: typeof raw.error === "string" ? raw.error.slice(0, 500) : "it failed" } };
      let size = Infinity;
      try { size = JSON.stringify(raw.result ?? null).length; } catch { /* not JSON */ }
      if (size > INVOKE_RESULT_MAX) return bad(`result must be JSON of at most ${INVOKE_RESULT_MAX} bytes`);
      return { ok: true, msg: { type: "invokeResult", invokeId: raw.invokeId, ok: true, result: raw.result ?? null } };
    }
    case "watchActivity": {
      if (!Array.isArray(raw.tileIds) || raw.tileIds.length > ACTIVITY_MAX_TILES || !raw.tileIds.every(isId)) return bad(`tileIds must be at most ${ACTIVITY_MAX_TILES} tile ids`);
      return { ok: true, msg: { type: "watchActivity", tileIds: [...new Set(raw.tileIds as string[])] } };
    }
    case "request": {
      if (!isNum(raw.requestId)) return bad("requestId must be a number");
      const args = raw.args;
      if (!Array.isArray(args) || args.length !== 1 || !isObj(args[0])) return bad("args must be [options]");
      const o = args[0];
      if (raw.name === "history") {
        if (!isDay(o.day)) return bad("day must be YYYY-MM-DD");
        return { ok: true, msg: { type: "request", requestId: raw.requestId, name: "history", args: [{ day: o.day }] } };
      }
      if (raw.name === "share") {
        if (!(o.png instanceof ArrayBuffer)) return bad("png must be an ArrayBuffer");
        if (o.png.byteLength === 0 || o.png.byteLength > SHARE_MAX_BYTES) return bad(`png must be 1 byte to ${SHARE_MAX_BYTES} bytes`);
        if (o.suggestedName !== undefined && (typeof o.suggestedName !== "string" || !SUGGESTED_NAME_RE.test(o.suggestedName))) return bad("suggestedName must be ≤ 64 letters, digits, spaces, dots or dashes");
        return { ok: true, msg: { type: "request", requestId: raw.requestId, name: "share", args: [{ png: o.png, ...(o.suggestedName ? { suggestedName: o.suggestedName as string } : {}) }] } };
      }
      if (raw.name === "agents") return { ok: true, msg: { type: "request", requestId: raw.requestId, name: "agents", args: [{}] } };
      if (raw.name === "sessions") {
        if (!isId(o.agent) || !isId(o.frameId)) return bad("agent and frameId must be ids");
        return { ok: true, msg: { type: "request", requestId: raw.requestId, name: "sessions", args: [{ agent: o.agent, frameId: o.frameId }] } };
      }
      if (raw.name === "prompt") {
        if (!isId(o.tileId)) return bad("tileId must be an id");
        const why = promptProblem(o.text);
        if (why) return bad(why);
        return { ok: true, msg: { type: "request", requestId: raw.requestId, name: "prompt", args: [{ tileId: o.tileId, text: o.text as string }] } };
      }
      if (raw.name === "issue") {
        if (!(ISSUE_CALLS as readonly unknown[]).includes(o.call)) return bad(`call must be one of ${ISSUE_CALLS.join(", ")}`);
        if (!Array.isArray(o.args) || o.args.length > 8) return bad("args must be at most 8 arguments");
        let size = Infinity;
        try { size = JSON.stringify(o.args).length; } catch { /* not JSON */ }
        if (size > ISSUE_ARGS_MAX) return bad(`args must be JSON of at most ${ISSUE_ARGS_MAX} bytes`);
        return { ok: true, msg: { type: "request", requestId: raw.requestId, name: "issue", args: [{ call: o.call as IssueCall, args: o.args as unknown[] }] } };
      }
      return bad(`unknown request ${quoted(raw.name)}`);
    }
    default:
      return { ok: false, reason: `unknown message type ${quoted(raw.type)}` };
  }
}

/** What a host has told a view, for `refusal`: what it granted and wired, the tiles and frames
 *  there are now, and whether it ever announced a tile (in a `structure`). */
export interface HostScope {
  capabilities: readonly ViewPermission[];
  features: readonly ViewFeature[];
  hasTile(id: string): boolean;
  hasFrame(id: string): boolean;
  announced(tileId: string): boolean;
}

/** The feature a subscription needs. */
const SUBSCRIPTION_FEATURE: Partial<Record<PluginMessage["type"], ViewFeature>> = {
  subscribeEvents: "events", watchActivity: "activity", subscribePresence: "presence", subscribeParticipants: "participants",
  subscribeWidgets: "widgets", pressWidget: "widgets", subscribeIssues: "issues",
};

/** Host side: why a well-formed message from a view is refused, or null when it is taken. A command
 *  the manifest did not ask for, one that names a tile or frame that is not there, a status for no
 *  tile, a subscription to a feature the host did not wire. Surface rects and watched tiles that
 *  are not there are refused and the rest of them `partly` taken, except a rect for a tile the host
 *  announced and has closed since: the view had not heard yet. The app's host and the fake one
 *  (`@hivemind/view-sdk/testing`) refuse alike. */
export function refusal(m: PluginMessage, host: HostScope): { why: string; partly: boolean } | null {
  const feature = SUBSCRIPTION_FEATURE[m.type];
  if (feature && !host.features.includes(feature)) return { why: `${m.type}: not supported`, partly: false };
  const why = refused(m, host);
  return why ? { why, partly: m.type === "surfaceRects" || m.type === "lineRects" || m.type === "watchActivity" } : null;
}

function refused(m: PluginMessage, host: HostScope): string | null {
  switch (m.type) {
    case "pressWidget":
      return host.capabilities.includes("workspace:widgets") ? null : 'pressWidget needs permission "workspace:widgets"';
    case "request":
      if (m.name !== "issue") return null;
      if (!host.features.includes("issues")) return "issue: not supported";
      return host.capabilities.includes("workspace:issues") ? null : `issue ${m.args[0].call} needs permission "workspace:issues"`;
    case "subscribeIssues":
      return host.capabilities.includes("workspace:issues") ? null : 'subscribeIssues needs permission "workspace:issues"';
    case "command": {
      const need = COMMAND_PERMISSION[m.name];
      if (need && !host.capabilities.includes(need)) return `${m.name} needs permission "${need}"`;
      const [a0, a1, a2] = m.args;
      const tile = (id: unknown) => (id === null || host.hasTile(id as string) ? null : `${m.name}: unknown tile ${String(id)}`);
      const frame = (id: unknown) => (id === null || host.hasFrame(id as string) ? null : `${m.name}: unknown frame ${String(id)}`);
      switch (m.name) {
        case "selectTile": case "focusTile": case "closeTile": case "renameTile": case "wakeAgent": case "sleepAgent": return tile(a0);
        case "selectFrame": case "openFolder": return frame(a0);
        case "spawnTile": return frame(a1);
        case "spawnAgent": {
          const opts = a2 as { prompt?: string; resume?: string } | undefined;
          if (opts?.prompt !== undefined && !host.capabilities.includes("workspace:prompt")) return 'spawnAgent with a prompt needs permission "workspace:prompt"';
          if (opts?.resume !== undefined && !host.capabilities.includes("workspace:sessions")) return 'spawnAgent with resume needs permission "workspace:sessions"';
          return frame(a1);
        }
        default: return null;
      }
    }
    case "subscribeStatus": return host.hasTile(m.tileId) ? null : `subscribeStatus: unknown tile ${m.tileId}`;
    case "surfaceRects": return m.rects.every((r) => host.hasTile(r.tileId) || host.announced(r.tileId)) ? null : "surfaceRects: unknown tile";
    case "lineRects": return m.rects.every((r) => host.hasTile(r.tileId) || host.announced(r.tileId)) ? null : "lineRects: unknown tile";
    case "watchActivity": return m.tileIds.every((id) => host.hasTile(id)) ? null : "watchActivity: unknown tile";
    default: return null;
  }
}

/** Plugin side: validate a message received from the host (lenient on extras). */
export function parseHostMessage(raw: unknown): ParseResult<HostMessage> {
  if (!isObj(raw) || typeof raw.type !== "string") return { ok: false, reason: "not an object with a string type" };
  const bad = (why: string): ParseResult<HostMessage> => ({ ok: false, reason: `${raw.type}: ${why}` });
  switch (raw.type) {
    case "hello":
      if (!isNum(raw.v) || !isId(raw.pluginId) || !Array.isArray(raw.capabilities) || !isObj(raw.theme) || !isObj(raw.viewport)) return bad("missing fields");
      return { ok: true, msg: raw as unknown as HostMessage };
    case "structure":
      if (!Array.isArray(raw.frames) || !Array.isArray(raw.tiles)) return bad("frames and tiles must be arrays");
      return { ok: true, msg: raw as unknown as HostMessage };
    case "names":
      return isObj(raw.names) ? { ok: true, msg: raw as unknown as HostMessage } : bad("names must be an object");
    case "selection":
      return isIdOrNull(raw.tileId) && isIdOrNull(raw.frameId) && typeof raw.fresh === "boolean" ? { ok: true, msg: raw as unknown as HostMessage } : bad("bad fields");
    case "status":
      if (raw.since !== undefined && !isNum(raw.since)) return bad("since must be a number");
      if (raw.exact !== undefined && typeof raw.exact !== "boolean") return bad("exact must be a boolean");
      if (raw.agent !== undefined && !(isObj(raw.agent) && AGENT_STATES.includes(raw.agent.state as ViewAgentState) && isNum(raw.agent.subagents))) return bad("agent must be an agent status");
      return isId(raw.tileId) && STATUSES.includes(raw.status as ViewStatus) ? { ok: true, msg: raw as unknown as HostMessage } : bad("bad fields");
    case "events":
      return Array.isArray(raw.events) && raw.events.every((e) => isObj(e) && EVENT_KINDS.includes(e.kind as ViewEventKind) && isNum(e.at))
        ? { ok: true, msg: raw as unknown as HostMessage } : bad("events must be an array of events");
    case "activity":
      return isObj(raw.levels) && Object.values(raw.levels).every((l) => l === 0 || l === 1 || l === 2 || l === 3)
        ? { ok: true, msg: raw as unknown as HostMessage } : bad("levels must map tile ids to 0..3");
    case "presence":
      return isObj(raw.presence) && ["active", "idle", "away"].includes(raw.presence.state as string) && isNum(raw.presence.since)
        ? { ok: true, msg: raw as unknown as HostMessage } : bad("bad presence");
    case "participants":
      return Array.isArray(raw.participants) && raw.participants.every(isParticipant)
        ? { ok: true, msg: raw as unknown as HostMessage } : bad("participants must be an array of participants");
    case "response":
      return isNum(raw.requestId) && typeof raw.ok === "boolean" && (raw.ok || isObj(raw.error))
        ? { ok: true, msg: raw as unknown as HostMessage } : bad("bad response");
    case "reveal":
      return isNum(raw.requestId) && isId(raw.tileId) ? { ok: true, msg: raw as unknown as HostMessage } : bad("bad fields");
    case "resize":
      return isNum(raw.w) && isNum(raw.h) ? { ok: true, msg: raw as unknown as HostMessage } : bad("bad fields");
    case "visibility":
      return typeof raw.visible === "boolean" ? { ok: true, msg: raw as unknown as HostMessage } : bad("visible must be a boolean");
    case "theme":
      return isObj(raw.theme) ? { ok: true, msg: raw as unknown as HostMessage } : bad("theme must be an object");
    case "fonts":
      return areFontFaces(raw.fontFaces) ? { ok: true, msg: raw as unknown as HostMessage } : bad("fontFaces must be a list of { family, data } faces");
    case "widgets":
      return Array.isArray(raw.widgets) && raw.widgets.every((w) => isObj(w) && isId(w.id) && typeof w.widget === "string")
        ? { ok: true, msg: raw as unknown as HostMessage } : bad("widgets must be an array of widgets");
    case "settings":
      return isObj(raw.settings) ? { ok: true, msg: raw as unknown as HostMessage } : bad("settings must be an object");
    case "issues":
      return Array.isArray(raw.issues) && raw.issues.every((i) => isObj(i) && typeof i.id === "string" && typeof i.title === "string")
        ? { ok: true, msg: raw as unknown as HostMessage } : bad("issues must be an array of issues");
    case "undock":
      return isId(raw.tileId) ? { ok: true, msg: raw as unknown as HostMessage } : bad("tileId must be a string");
    case "invoke":
      return isNum(raw.invokeId) && typeof raw.name === "string" ? { ok: true, msg: raw as unknown as HostMessage } : bad("invokeId must be a number and name a string");
    case "widgetBand":
      return (raw.edge === "left" || raw.edge === "right") && isNum(raw.width) && raw.width >= 0
        ? { ok: true, msg: { type: "widgetBand", edge: raw.edge, width: raw.width } } : bad("edge must be \"left\" or \"right\" and width a number from 0");
    default:
      return { ok: false, reason: `unknown message type ${quoted(raw.type)}` };
  }
}

/** Whether `v` is a list of font faces a client may load (1.17): a plain family and base64 bytes. */
export function areFontFaces(v: unknown): v is ViewFontFace[] {
  return Array.isArray(v) && v.length <= MAX_VIEW_FONT_FACES && v.every((f) => isObj(f)
    && typeof f.family === "string" && /^[A-Za-z0-9][A-Za-z0-9 _-]{0,59}$/.test(f.family)
    && typeof f.data === "string" && f.data.length <= MAX_VIEW_FONT_DATA && /^[A-Za-z0-9+/]*={0,2}$/.test(f.data)
    && (f.weight === undefined || typeof f.weight === "string") && (f.style === undefined || typeof f.style === "string"));
}

/** The message the host posts to the iframe window to hand over the port. */
export const PORT_HANDSHAKE = "hivemind-view:port";
