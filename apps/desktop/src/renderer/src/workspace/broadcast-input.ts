/**
 * Typing into several terminals at once (view protocol 1.21, `broadcastInput`): one group per window,
 * each member by its tile and the session its keys go to. What is typed into a member is written to
 * every member whose keyboard is this person's; Escape alone ends the group and goes to none of them.
 * A member that closes leaves it, and a group of fewer than two ends. Only what the person typed or
 * pasted is copied: a terminal's replies to its program (cursor position, focus, mouse) are its own.
 * The group belongs to the view that set it and ends when that view goes.
 */

export interface BroadcastMember { tile: string; pty: string }

let members: readonly BroadcastMember[] = [];
/** The view whose group it is. */
let owner: object | null = null;
const listeners = new Set<(tiles: readonly string[]) => void>();
let tiles: readonly string[] = [];
/** Terminals whose keyboard someone else holds now, as each terminal says. */
const heldElsewhere = new Set<string>();
let held: readonly string[] = [];

function notify() {
  tiles = members.map((m) => m.tile);
  held = tiles.filter((t) => heldElsewhere.has(t));
  for (const l of listeners) l(tiles);
}

/** A terminal says whether this person's keys reach it. Cheap when nothing changed: one lookup. */
export function setTerminalTypable(tile: string, mayType: boolean): void {
  if (heldElsewhere.has(tile) === !mayType) return;
  if (mayType) heldElsewhere.delete(tile); else heldElsewhere.add(tile);
  if (members.some((m) => m.tile === tile)) notify();
}

/** The group's members whose keyboard someone else holds: skipped, and shown so. */
export const broadcastHeld = (): readonly string[] => held;

/** The group from now on, set by view `by`; fewer than two members is none. */
export function setBroadcastGroup(next: readonly BroadcastMember[], by: object | null): void {
  const seen = new Set<string>();
  const kept = next.filter((m) => !seen.has(m.tile) && seen.add(m.tile));
  const now = kept.length >= 2 ? kept : [];
  owner = now.length ? by : null;
  if (now.length === members.length && now.every((m, i) => m.tile === members[i]!.tile && m.pty === members[i]!.pty)) return;
  members = now;
  notify();
}

/** View `by` sees only these tiles open: the rest leave its group. Another view's tiles say nothing. */
export function keepBroadcastTiles(by: object, open: (tile: string) => boolean): void {
  if (owner === by && members.some((m) => !open(m.tile))) setBroadcastGroup(members.filter((m) => open(m.tile)), by);
}

/** View `by` is gone: its group ends with it. */
export function endBroadcastOf(by: object): void {
  if (owner === by) setBroadcastGroup([], null);
}

/** The group's tiles now: the same list until it changes. */
export const broadcastTiles = (): readonly string[] => tiles;

/** The group's tiles now and on every change, until the returned function is called. */
export function followBroadcast(cb: (tiles: readonly string[]) => void): () => void {
  listeners.add(cb);
  cb(tiles);
  return () => { listeners.delete(cb); };
}

/** A mouse report (SGR), which the terminal marks as the person's but which names a place on its own screen. */
const MOUSE_REPORT_RE = /^\x1b\[<\d+;\d+;\d+[Mm]$/;

/**
 * What a terminal does with `data` it sends from tile `from`, `byPerson` when the person typed or
 * pasted it: false when the group took it (written to every member through `write`, or Escape, which
 * ends the group); true when it is the terminal's own to send. Cheap when no group is on: one length check.
 */
export function typedIntoTerminal(from: string, data: string, byPerson: boolean, write: (pty: string, data: string) => void): boolean {
  if (!members.length || !byPerson || MOUSE_REPORT_RE.test(data) || !members.some((m) => m.tile === from)) return true;
  if (data === "\x1b") { setBroadcastGroup([], null); return false; }
  for (const m of members) if (!heldElsewhere.has(m.tile)) write(m.pty, data);
  return false;
}

type UserInputHook = { _core?: { coreService?: { onUserInput?: (cb: () => void) => unknown } } };
let warned = false;

/**
 * Whether what terminal `term` sends its session next (`onData`) is the person's: the terminal marks
 * its keys, pastes and typed-in text just before sending them, never its replies to a program. Read
 * once per send; ends with the terminal. Where the terminal cannot say, nothing is the person's, so
 * nothing is copied to a group.
 */
export function personInputOf(term: unknown): () => boolean {
  const core = (term as UserInputHook)._core?.coreService;
  if (!core?.onUserInput) {
    if (!warned) console.warn("[hivemind] this terminal does not say what the person typed; typing into several at once is off");
    warned = true;
    return () => false;
  }
  let marked = false;
  core.onUserInput.call(core, () => { marked = true; });
  return () => { const was = marked; marked = false; return was; };
}
