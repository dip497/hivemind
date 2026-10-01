/**
 * Who is typing where (R4, design §4.2 C), as a window hears it: the host names whoever types into
 * a terminal to the others showing it (`terminal.typing`, at most once a second while they type
 * on). The terminal's title bar says so for a moment after, and that person's pointer is hidden
 * from the board meanwhile. This person's own typing, at another of their windows or devices, is
 * not shown.
 */
import { useSyncExternalStore } from "react";

/** How long after it was last heard of someone still shows as typing. */
export const TYPING_SHOWN_MS = 2500;

/** Who types into each terminal, by its session, and until when. */
const byTile = new Map<string, { name: string; until: number }>();
/** Until when each person shows as typing, by their key. */
const byPerson = new Map<string, number>();
let typing: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
let listening = false;
let myself: string | null = null;

function changed(): void {
  typing = new Set(byPerson.keys());
  for (const l of listeners) l();
}

/** Forget what has run out by now. */
function expire(): void {
  const now = Date.now();
  for (const [tile, t] of byTile) if (t.until <= now) byTile.delete(tile);
  for (const [person, until] of byPerson) if (until <= now) byPerson.delete(person);
  changed();
}

function listen(): void {
  if (listening) return;
  listening = true;
  void window.hive.identity().then((id) => { myself = id?.personId ?? null; }, () => {});
  window.hive.onTyping((tile, by) => {
    if (by.person === myself) return;
    const until = Date.now() + TYPING_SHOWN_MS;
    byTile.set(tile, { name: by.name || "Someone", until });
    byPerson.set(by.person, until);
    changed();
    setTimeout(expire, TYPING_SHOWN_MS + 50);
  });
}

function subscribe(listener: () => void): () => void {
  listen();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Who is typing into the terminal whose session is `tile` now: their name, or null. */
export function useTyping(tile: string): string | null {
  return useSyncExternalStore(subscribe, () => byTile.get(tile)?.name ?? null);
}

/** The people typing into a terminal now, by their key. */
export function useTypingPeople(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => typing);
}
