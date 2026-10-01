/**
 * One keyboard per terminal, as a window sees it (M2; design §4.2 D). The host tells every window
 * who holds each terminal's keyboard (nobody named: its host), tells the one holding it (the
 * host's windows, while the host does) when someone asks for it, and says each session's size.
 * What is heard is kept for the terminals a window shows, from before the first word: a terminal
 * is told who holds its keyboard as it opens.
 *
 * A terminal draws its part from `useTerminalKeyboard`: who has the keyboard, in its title bar,
 * once the workspace is shared; whether this window's keys reach it; asking for it (a guest who
 * may use terminals), giving it to whoever asks, and taking it back (the host).
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { Keyboard } from "lucide-react";
import type { Typist } from "@hivemind/workspace-api/terminals";
import type { PtySize } from "../pty-size-sync";
import { Button } from "../components/ui/button";
import { useFacesHere } from "./presence";
import { joinedId, useShown } from "./shown";

interface Heard {
  /** Who holds it: null while the host does. */
  holder: Typist | null;
  /** Who asks this window for it. */
  asks: Typist[];
  /** The session's size, as last said. */
  size: PtySize | null;
}
const NOTHING: Heard = { holder: null, asks: [], size: null };
const heard = new Map<string, Heard>();
const listeners = new Map<string, Set<() => void>>();
let listening = false;
/** This device as its host names it, `peer:<device>`; null until the app says. */
let me: string | null = null;

/** What `tile` heard changed; nothing is kept for a terminal no one here shows. */
function change(tile: string, patch: Partial<Heard>): void {
  const told = listeners.get(tile);
  if (!told) return;
  heard.set(tile, { ...(heard.get(tile) ?? NOTHING), ...patch });
  for (const l of told) l();
}

function listen(): void {
  if (listening) return;
  listening = true;
  void window.hive.identity().then((id) => {
    me = id ? `peer:${id.deviceId}` : null;
    for (const tile of listeners.keys()) change(tile, {});
  }, () => {});
  // The asks were to whoever held it: once it moves, they are the new holder's to hear.
  window.hive.onKeyboard((tile, holder) => change(tile, { holder, asks: [] }));
  window.hive.onKeyboardAsked((tile, asker) => {
    const asks = (heard.get(tile) ?? NOTHING).asks.filter((a) => a.id !== asker.id);
    change(tile, { asks: [...asks, asker] });
  });
  window.hive.onTerminalSize((tile, cols, rows) => change(tile, { size: { cols, rows } }));
}

function subscribe(tile: string, listener: () => void): () => void {
  listen();
  let told = listeners.get(tile);
  if (!told) listeners.set(tile, (told = new Set()));
  told.add(listener);
  return () => {
    told!.delete(listener);
    if (told!.size > 0 || listeners.get(tile) !== told) return;
    listeners.delete(tile);
    heard.delete(tile);
  };
}

/** Forget an ask this window answered "not now". */
function drop(tile: string, asker: string): void {
  const now = heard.get(tile);
  if (now) change(tile, { asks: now.asks.filter((a) => a.id !== asker) });
}

export interface TerminalKeyboard {
  /** Who has it, as this window names them; null while nobody else is in the workspace. */
  holder: { name: string; you: boolean } | null;
  /** Whether this window's keys reach the terminal. */
  mayType: boolean;
  /** A guest who may use terminals, without it: they may ask for it. */
  mayAsk: boolean;
  /** The host's window, while a guest has it: it may take it back. */
  mayTake: boolean;
  /** Who asks this window for it, while it may give it. */
  asks: Typist[];
  /** The session's size, as last said; null when none was. */
  size: PtySize | null;
}

/** The keyboard of the terminal whose session is `tile`, as this window sees it. */
export function useTerminalKeyboard(tile: string): TerminalKeyboard {
  const { repo, shared } = useShown();
  const joined = joinedId(repo);
  const others = useFacesHere(repo).length > 0;
  const now = useSyncExternalStore(useCallback((l: () => void) => subscribe(tile, l), [tile]), () => heard.get(tile) ?? NOTHING);
  const { holder, size } = now;
  // A workspace of this person's own on a host of theirs (R14): here as the host, not as a guest.
  if (joined && shared?.access !== "owner") {
    const you = !!holder && holder.id === me;
    const host = shared?.names.host || "The host";
    const drives = shared?.state === "connected" && (shared.access === "terminals" || shared.access === "agents");
    return {
      holder: holder ? { name: you ? "You" : holder.name || "Someone", you } : { name: host, you: false },
      mayType: you,
      mayAsk: !you && drives,
      mayTake: false,
      asks: you ? now.asks : [],
      size,
    };
  }
  return {
    holder: holder ? { name: holder.name || "Someone", you: false } : others ? { name: "You", you: true } : null,
    mayType: !holder,
    mayAsk: false,
    mayTake: !!holder,
    asks: holder ? [] : now.asks,
    size,
  };
}

/** How long "Asked" shows before asking is offered again: an ask nobody answers is let go. */
const ASKED_FOR_MS = 30_000;

/**
 * In a terminal's title bar: who has its keyboard (once someone else is in the workspace); asking
 * for it, or taking it back; and the asks this window may answer, as toasts.
 */
export function KeyboardChip({ tile, name, kb }: { tile: string; name: string; kb: TerminalKeyboard }) {
  const asked = useAsked(tile, kb.holder?.name);
  useAsks(tile, name, kb.asks);
  if (!kb.holder) return null;
  return (
    <span className="nodrag inline-flex shrink-0 items-center gap-1 text-[10.5px] text-[var(--color-fg3)]" data-keyboard={tile} data-keyboard-holder={kb.holder.name}>
      <span className="inline-flex items-center gap-1 rounded bg-[var(--color-bg)] px-1 py-px" title={kb.holder.you ? "You have the keyboard" : `${kb.holder.name} has the keyboard`}>
        <Keyboard size={11} aria-hidden /> {kb.holder.name}
      </span>
      {kb.mayTake && (
        <Button variant="ghost" size="micro" onClick={() => window.hive.keyboardTake(tile)} title="Take the keyboard back (Ctrl/⌘⇧K)" data-keyboard-take>
          Take back
        </Button>
      )}
      {kb.mayAsk && (
        <Button variant="ghost" size="micro" onClick={asked.ask} disabled={asked.waiting} data-keyboard-ask>
          {asked.waiting ? "Asked" : "Ask for keyboard"}
        </Button>
      )}
    </span>
  );
}

/**
 * Over a terminal this window's keys do not reach, while it is selected: who has the keyboard,
 * and asking for it or taking it back (design §4.2 D: a guest who clicks into it is offered the
 * keyboard).
 */
export function KeyboardPill({ tile, kb }: { tile: string; kb: TerminalKeyboard }) {
  const asked = useAsked(tile, kb.holder?.name);
  if (kb.mayType || !kb.holder || !(kb.mayAsk || kb.mayTake)) return null;
  return (
    <div className="nodrag pointer-events-auto absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full border border-[var(--color-line)] bg-[var(--color-bg2)] px-3 py-1 text-[12px] shadow-md" role="status" data-keyboard-pill={tile}>
      <Keyboard size={13} aria-hidden />
      <span>{kb.holder.name} {kb.holder.name === "You" ? "have" : "has"} the keyboard</span>
      {kb.mayTake && <Button size="sm" variant="secondary" onClick={() => window.hive.keyboardTake(tile)}>Take back</Button>}
      {kb.mayAsk && (
        <Button size="sm" variant="secondary" onClick={asked.ask} disabled={asked.waiting} data-keyboard-pill-ask>
          {asked.waiting ? `Asked ${kb.holder.name}` : "Ask for keyboard"}
        </Button>
      )}
    </div>
  );
}

/** Asking for `tile`'s keyboard: "Asked" until it moves, or for a while. */
function useAsked(tile: string, holder: string | undefined): { waiting: boolean; ask: () => void } {
  const [waiting, setWaiting] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { setWaiting(false); }, [holder]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const ask = useCallback(() => {
    window.hive.keyboardAsk(tile);
    setWaiting(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setWaiting(false), ASKED_FOR_MS);
  }, [tile]);
  return { waiting, ask };
}

/** Each ask this window may answer, as a toast: Give, or Not now. One toast per asker, gone once
 *  the keyboard moves. */
function useAsks(tile: string, name: string, asks: Typist[]): void {
  const shown = useRef(new Set<string>());
  useEffect(() => {
    const ids = new Set(asks.map((a) => `keyboard:${tile}:${a.id}`));
    for (const id of shown.current) if (!ids.has(id)) { toast.dismiss(id); shown.current.delete(id); }
    for (const a of asks) {
      const id = `keyboard:${tile}:${a.id}`;
      if (shown.current.has(id)) continue;
      shown.current.add(id);
      toast(`${a.name || "Someone"} asks for the keyboard`, {
        id,
        description: name,
        duration: Infinity,
        action: { label: "Give", onClick: () => window.hive.keyboardGive(tile, a.id) },
        cancel: { label: "Not now", onClick: () => drop(tile, a.id) },
      });
    }
  }, [tile, name, asks]);
  useEffect(() => () => { for (const id of shown.current) toast.dismiss(id); }, []);
}
