/**
 * Who else is in this workspace, and where (M1; design §4.2 C). The window says its person is in
 * the workspace it shows, whichever view shows it (`presence.set`): what they have selected and,
 * on the canvas, where their pointer is and what it is over; again whenever that changes, at most
 * every 50 ms, and every 20 s while nothing does, so the host does not take them for gone; and
 * that they left when it stops showing the workspace. It hears who is there (`presence.changed`).
 * Others' pointers are drawn on the canvas with their names, what they have selected is ringed in
 * their colour, their faces sit by Share, and a community view is told of them (protocol 1.5).
 * The person here is never shown to themselves, whichever of their windows they are at.
 */
import { useEffect, useMemo, useRef, useSyncExternalStore, type RefObject } from "react";
import { useInternalNode, useReactFlow, useStore, ViewportPortal } from "@xyflow/react";
import type { Participant, PresenceState } from "@hivemind/workspace-host/presence";
import { useSettings } from "../settings-store";
import { colorOf, initialsOf } from "./people";
import { useTypingPeople } from "./typing";

const SEND_EVERY_MS = 50;
const STILL_HERE_EVERY_MS = 20_000;
const NOBODY: Participant[] = [];
/** Someone else in a workspace, one per person, as their face shows them. */
export type Face = Pick<Participant, "person" | "name" | "color">;
const NO_FACES: Face[] = [];

/** This person, once the app has said who that is; null where no app answers (a browser). */
let me: { personId: string; suggestedName: string } | null = null;
/** Who is in each workspace, as last heard, and who of them is someone else; and their faces,
 *  which change only when someone arrives, leaves or is renamed, not as they move. */
const heard = new Map<string, Participant[]>();
const others = new Map<string, Participant[]>();
const faces = new Map<string, Face[]>();
const listeners = new Set<() => void>();
let listening = false;

/** Whether who else is in `repo` changed. */
function sift(repo: string): boolean {
  const next = me ? (heard.get(repo) ?? NOBODY).filter((p) => p.person !== me!.personId) : NOBODY;
  const prev = others.get(repo);
  if (prev && JSON.stringify(prev) === JSON.stringify(next)) return false;
  others.set(repo, next);
  const nextFaces = [...new Map(next.map((p) => [p.person, { person: p.person, name: p.name, color: p.color }])).values()];
  if (JSON.stringify(nextFaces) !== JSON.stringify(faces.get(repo) ?? NO_FACES)) faces.set(repo, nextFaces);
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

/** Who else is in the workspace `repo` now, where they are and what they have selected: changes
 *  as they move. */
export function usePeopleHere(repo: string | null): Participant[] {
  return useSyncExternalStore(subscribe, () => (repo ? others.get(repo) ?? NOBODY : NOBODY));
}

/** The faces of everyone else in `repo`, one per person: changes only as people come and go. */
export function useFacesHere(repo: string | null): Face[] {
  return useSyncExternalStore(subscribe, () => (repo ? faces.get(repo) ?? NO_FACES : NO_FACES));
}

/** Who else is in `repo`, now and whenever that changes, for what is not a component (a view's
 *  host). Returns the unsubscribe. */
export function watchPeopleHere(repo: string, cb: (people: Participant[]) => void): () => void {
  let told: Participant[] | null = null;
  const pass = (): void => {
    const now = others.get(repo) ?? NOBODY;
    if (now !== told) cb((told = now));
  };
  const off = subscribe(pass);
  pass();
  return off;
}

/** Where someone points: what the canvas adds to what a window says. */
type Pointing = Omit<PresenceState, "name" | "color" | "selection">;
/** Where this window's person points on the board of a workspace, while the canvas shows it. */
const pointers = new Map<string, () => Pointing>();
/** Each workspace this window says it is in: say it again soon. */
const sayers = new Map<string, () => void>();
const NOWHERE: Pointing = { cursor: null, over: null };

/**
 * Says this window's person is in `repo`, whichever view shows it: their name and colour, what
 * they have selected (`selection`) and, while the canvas shows it, where they point. Again at most
 * every 50 ms as that changes, and every 20 s while it does not; and that they left, when the
 * window stops showing the workspace.
 */
export function SayHere({ repo, selection }: { repo: string; selection: string[] }): null {
  const { profile } = useSettings();
  const whoAmI = useSyncExternalStore(subscribe, () => me);
  const said = useRef<Pick<PresenceState, "name" | "color" | "selection">>({ name: "", color: "", selection: [] });
  const soon = useRef<() => void>(() => {});

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let sentAt = 0;
    const send = (): void => {
      if (timer) clearTimeout(timer);
      timer = null;
      sentAt = Date.now();
      window.hive.boardPresenceSet(repo, { ...said.current, ...(pointers.get(repo)?.() ?? NOWHERE) });
    };
    soon.current = () => { timer ??= setTimeout(send, Math.max(0, SEND_EVERY_MS - (Date.now() - sentAt))); };
    sayers.set(repo, () => soon.current());
    const gone = (): void => window.hive.boardPresenceSet(repo, null);
    window.addEventListener("pagehide", gone);
    // A host reconnected to has forgotten this window: say where it is again.
    const offBack = window.hive.onSharedStatus((ws, s) => { if (`hive://${ws}` === repo && s.state === "connected") send(); });
    const still = setInterval(send, STILL_HERE_EVERY_MS);
    send();
    return () => {
      sayers.delete(repo);
      offBack();
      window.removeEventListener("pagehide", gone);
      clearInterval(still);
      if (timer) clearTimeout(timer);
      soon.current = () => {};
      gone();
    };
  }, [repo]);

  const name = profile.name || whoAmI?.suggestedName || "";
  const selected = selection.join("\n");
  useEffect(() => {
    said.current = { name, color: profile.color, selection: selected ? selected.split("\n") : [] };
    soon.current();
  }, [name, profile.color, selected]);
  return null;
}

/**
 * Inside the canvas: where this window's person points on the board of `repo` (the pointer over
 * `pane`, and what it is over), for `SayHere` to say; and everyone else's pointers and selections.
 */
export function PresenceLayer({ repo, pane }: { repo: string; pane: RefObject<HTMLElement | null> }) {
  const { screenToFlowPosition } = useReactFlow();
  const people = usePeopleHere(repo);
  // Someone typing into a terminal shows there ("Priya is typing"), not as a pointer.
  const typing = useTypingPeople();

  useEffect(() => {
    const el = pane.current;
    if (!el) return undefined;
    let pointer: { x: number; y: number } | null = null;
    let over: string | null = null;
    const moved = (): void => sayers.get(repo)?.();
    const move = (e: PointerEvent): void => {
      pointer = { x: e.clientX, y: e.clientY };
      over = (e.target as Element | null)?.closest?.(".react-flow__node")?.getAttribute("data-id") ?? null;
      moved();
    };
    const leave = (): void => { pointer = null; over = null; moved(); };
    el.addEventListener("pointermove", move, { passive: true });
    el.addEventListener("pointerleave", leave);
    pointers.set(repo, () => ({ cursor: pointer ? screenToFlowPosition(pointer) : null, over }));
    return () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
      pointers.delete(repo);
      moved();
    };
  }, [repo, pane, screenToFlowPosition]);

  const [panX, panY, zoom] = useStore((s) => s.transform);
  const rings = useMemo(() => people.flatMap((p) => p.selection.map((id) => ({ id, p }))), [people]);
  if (people.length === 0) return null;
  return (
    <>
      {rings.length > 0 && (
        <ViewportPortal>
          {rings.map(({ id, p }) => <SelectionRing key={`${p.id}:${id}`} id={id} who={p} />)}
        </ViewportPortal>
      )}
      {/* Pointers over the board rather than in it: a pointer that moves repaints this layer only,
          not the board of a hundred tiles under it. No shadow filter: it is repainted each move. */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" style={{ contain: "strict", zIndex: 10_000 }}>
        {people.map((p) => p.cursor && !typing.has(p.person) && (
          <div
            key={p.id}
            data-presence-cursor={p.person}
            className="absolute left-0 top-0"
            style={{ transform: `translate(${p.cursor.x * zoom + panX}px, ${p.cursor.y * zoom + panY}px)`, color: colorOf(p) }}
          >
            <svg width={16} height={20} viewBox="0 0 16 20" aria-hidden className="block">
              <path d="M1 1 L1 16 L5 12 L8 19 L11 18 L8 11 L14 11 Z" fill="currentColor" stroke="var(--color-fg)" strokeWidth={1.2} strokeLinejoin="round" />
            </svg>
            <span className="ml-3 -mt-1 block w-max max-w-[180px] truncate rounded px-1.5 py-0.5 text-[11px] font-medium text-white" style={{ background: colorOf(p) }}>
              {p.name || "Someone"}
            </span>
          </div>
        ))}
      </div>
    </>
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
  const persons = useFacesHere(repo);
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
