/**
 * Who else is in this workspace, and where (M1; design §4.2 C). The window says where its person's
 * pointer is on the board and what they have selected (`presence.set`): again whenever either
 * changes, at most every 50 ms, and every 20 s while nothing does, so the host does not take them
 * for gone; and that they left when it stops showing the workspace. It hears who is there
 * (`presence.changed`). Others' pointers are drawn on the canvas with their names, what they have
 * selected is ringed in their colour, and their faces sit by Share. The person here is never
 * shown to themselves, whichever of their windows they are at.
 */
import { useEffect, useMemo, useRef, useSyncExternalStore, type RefObject } from "react";
import { useInternalNode, useReactFlow, useStore, ViewportPortal } from "@xyflow/react";
import type { Participant, PresenceState } from "@hivemind/workspace-host/presence";
import { useSettings } from "../settings-store";
import { colorFor, initialsOf } from "./people";

const SEND_EVERY_MS = 50;
const STILL_HERE_EVERY_MS = 20_000;
const NOBODY: Participant[] = [];

/** This person, once the app has said who that is; null where no app answers (a browser). */
let me: { personId: string; suggestedName: string } | null = null;
/** Who is in each workspace, as last heard, and who of them is someone else. */
const heard = new Map<string, Participant[]>();
const others = new Map<string, Participant[]>();
const listeners = new Set<() => void>();
let listening = false;

/** Whether who else is in `repo` changed. */
function sift(repo: string): boolean {
  const next = me ? (heard.get(repo) ?? NOBODY).filter((p) => p.person !== me!.personId) : NOBODY;
  const prev = others.get(repo);
  if (prev && JSON.stringify(prev) === JSON.stringify(next)) return false;
  others.set(repo, next);
  return true;
}
const tell = (): void => { for (const l of listeners) l(); };

function listen(): void {
  if (listening) return;
  listening = true;
  void window.hive.identity().then((id) => {
    me = id ? { personId: id.personId, suggestedName: id.suggestedName } : null;
    for (const repo of heard.keys()) sift(repo);
    tell();
  }, () => {});
  window.hive.onBoardPresence((repo, people) => {
    heard.set(repo, people);
    if (sift(repo)) tell();
  });
}
const subscribe = (l: () => void): (() => void) => {
  listen();
  listeners.add(l);
  return () => { listeners.delete(l); };
};

/** Who else is in the workspace `repo` now. */
export function usePeopleHere(repo: string | null): Participant[] {
  return useSyncExternalStore(subscribe, () => (repo ? others.get(repo) ?? NOBODY : NOBODY));
}

const colorOf = (p: Participant): string => p.color || colorFor(p.person);

/**
 * Inside the canvas: says where this window's person is on the board of `repo` (the pointer over
 * `pane`, and `selection`), and draws everyone else's.
 */
export function PresenceLayer({ repo, pane, selection }: { repo: string; pane: RefObject<HTMLElement | null>; selection: string[] }) {
  const { screenToFlowPosition } = useReactFlow();
  const { profile } = useSettings();
  const people = usePeopleHere(repo);
  const said = useRef<Pick<PresenceState, "name" | "color" | "selection">>({ name: "", color: "", selection: [] });
  const soon = useRef<() => void>(() => {});

  useEffect(() => {
    const el = pane.current;
    if (!el) return undefined;
    let pointer: { x: number; y: number } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let sentAt = 0;
    const send = (): void => {
      if (timer) clearTimeout(timer);
      timer = null;
      sentAt = Date.now();
      window.hive.boardPresenceSet(repo, { ...said.current, cursor: pointer ? screenToFlowPosition(pointer) : null });
    };
    soon.current = () => { timer ??= setTimeout(send, Math.max(0, SEND_EVERY_MS - (Date.now() - sentAt))); };
    const move = (e: PointerEvent): void => { pointer = { x: e.clientX, y: e.clientY }; soon.current(); };
    const leave = (): void => { pointer = null; soon.current(); };
    const gone = (): void => window.hive.boardPresenceSet(repo, null);
    el.addEventListener("pointermove", move, { passive: true });
    el.addEventListener("pointerleave", leave);
    window.addEventListener("pagehide", gone);
    // A host reconnected to has forgotten this window: say where it is again.
    const offBack = window.hive.onSharedStatus((ws, s) => { if (`hive://${ws}` === repo && s.state === "connected") send(); });
    const still = setInterval(send, STILL_HERE_EVERY_MS);
    send();
    return () => {
      offBack();
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
      window.removeEventListener("pagehide", gone);
      clearInterval(still);
      if (timer) clearTimeout(timer);
      soon.current = () => {};
      gone();
    };
  }, [repo, pane, screenToFlowPosition]);

  const name = profile.name || me?.suggestedName || "";
  const selected = selection.join("\n");
  useEffect(() => {
    said.current = { name, color: profile.color, selection: selected ? selected.split("\n") : [] };
    soon.current();
  }, [name, profile.color, selected]);

  const zoom = useStore((s) => s.transform[2]);
  const rings = useMemo(() => people.flatMap((p) => p.selection.map((id) => ({ id, p }))), [people]);
  if (people.length === 0) return null;
  return (
    <ViewportPortal>
      {rings.map(({ id, p }) => <SelectionRing key={`${p.id}:${id}`} id={id} who={p} />)}
      {people.map((p) => p.cursor && (
        <div
          key={p.id}
          data-presence-cursor={p.person}
          className="pointer-events-none absolute left-0 top-0"
          style={{ transform: `translate(${p.cursor.x}px, ${p.cursor.y}px) scale(${1 / zoom})`, transformOrigin: "0 0", zIndex: 10_000, color: colorOf(p) }}
        >
          <svg width={16} height={20} viewBox="0 0 16 20" aria-hidden className="block drop-shadow">
            <path d="M1 1 L1 16 L5 12 L8 19 L11 18 L8 11 L14 11 Z" fill="currentColor" stroke="white" strokeWidth={1.2} strokeLinejoin="round" />
          </svg>
          <span className="ml-3 -mt-1 block w-max max-w-[180px] truncate rounded px-1.5 py-0.5 text-[11px] font-medium text-white" style={{ background: colorOf(p) }}>
            {p.name || "Someone"}
          </span>
        </div>
      ))}
    </ViewportPortal>
  );
}

/** What someone else has selected, ringed in their colour. */
function SelectionRing({ id, who }: { id: string; who: Participant }) {
  const node = useInternalNode(id);
  if (!node) return null;
  const { x, y } = node.internals.positionAbsolute;
  return (
    <div
      data-presence-selection={id}
      className="pointer-events-none absolute left-0 top-0 rounded-[10px]"
      style={{
        transform: `translate(${x - 4}px, ${y - 4}px)`,
        width: (node.measured?.width ?? 0) + 8,
        height: (node.measured?.height ?? 0) + 8,
        outline: `2px solid ${colorOf(who)}`,
        zIndex: 9_999,
      }}
    />
  );
}

/** The faces of everyone else in `repo`, one per person, by Share; `onManage`, when given, opens
 *  the People panel from them. */
export function PeopleHere({ repo, onManage }: { repo: string; onManage?: () => void }) {
  const people = usePeopleHere(repo);
  const persons = useMemo(() => [...new Map(people.map((p) => [p.person, p])).values()], [people]);
  if (persons.length === 0) return null;
  return (
    <div
      className={`pointer-events-auto flex items-center -space-x-1.5 pr-1 ${onManage ? "cursor-pointer" : ""}`}
      data-people-here
      onClick={onManage}
      title={onManage ? "People" : undefined}
    >
      {persons.slice(0, 5).map((p) => (
        <span
          key={p.person}
          title={p.name || "Someone"}
          data-person={p.person}
          className="grid size-7 place-items-center rounded-full text-[11px] font-semibold text-white ring-2 ring-[var(--color-bg)]"
          style={{ background: colorOf(p) }}
        >
          {initialsOf(p.name)}
        </span>
      ))}
      {persons.length > 5 && (
        <span className="grid size-7 place-items-center rounded-full bg-[var(--color-bg3)] text-[11px] text-[var(--color-fg2)] ring-2 ring-[var(--color-bg)]">
          +{persons.length - 5}
        </span>
      )}
    </div>
  );
}
