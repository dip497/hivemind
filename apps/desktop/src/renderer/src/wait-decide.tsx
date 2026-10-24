/**
 * Allow and Deny, for an agent that waits on the person's permission to use a tool
 * (docs/design/last-line-2026-10-23.md §2, §3): in its Layers row and in its toast. They answer
 * `agent.answer` with the wait's `since`, so an answer that comes late (someone else answered, or
 * the agent stopped waiting) answers nothing and says so.
 *
 * Allowing is one click, so they are offered only when the person sees all of what they allow
 * (`inSight`): the tool's input is one short line of plain text, decided on the text as the agent
 * wrote it, and none of it is cut where it shows. Otherwise the place offers Review, which shows the
 * whole input first, its line breaks kept, with Deny where the keyboard lands. A view's line slot
 * offers Review alone: the view places the slot, so it could place Allow under the pointer. A
 * permission whose agent says no more than the kind of wait offers neither: its tile shows what for.
 *
 * Each wait gets buttons of its own (keyed by its `since`): a new one closes an open Review, and a
 * press in its first half second answers nothing, so a click meant for one prompt never answers
 * the next.
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { oneLine } from "@hivemind/agent-host/one-line";
import { Button } from "./components/ui/button";
import { waitOf, type AgentWait } from "./agent-waits";

/** The most of a tool's input a review shows (a wait's input is cut at the same before it gets
 *  here, `hive-agents/src/transcript.ts`). */
export const REVIEW_MAX = 4000;
/** How long a wait's buttons take no press after they appear. */
export const ARM_MS = 500;

/** Whether `waiting` can be allowed or denied from here: a permission its agent says the keys of
 *  (`decide`), for a tool whose input is known. */
export function decidable(waiting: AgentWait | undefined): waiting is AgentWait & { tool: { name: string; about: string } } {
  return !!waiting && waiting.kind === "permission" && !!waiting.decide && !!waiting.tool?.name && !!waiting.tool.about?.trim();
}

/** A run of spaces, which a line shows as one gap that can push the rest out of sight. */
const SPACES = / {2}/;
/** Characters that show as nothing: format controls (bidi, zero-width, joiners) and blank letters. */
const INVISIBLE = /[\p{Cf}\u034f\u115f\u1160\u3164\uffa0]/u;

/** Whether all of what `about` runs is in a line that shows it: one line, of at most `LINE_MAX`
 *  characters, with nothing a line strips or cuts (`oneLine` makes any line break or tab a space,
 *  drops controls and cuts at `LINE_MAX`, so it gives back the text itself only when it has none of
 *  them), no run of spaces and nothing invisible. Decided on the text as the agent wrote it, never
 *  on the line made of it. */
export function inSight(about: string): boolean {
  const text = about.trim();
  return oneLine(about) === text && !SPACES.test(text) && !INVISIBLE.test(text);
}

/** C0 and C1 controls but tab and line feed, and every format control (bidi, zero-width). */
// eslint-disable-next-line no-control-regex
const REVIEW_UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\p{Cf}]/gu;
/** Line breaks of every kind, which a review shows as one. */
const REVIEW_BREAKS = /\r\n|[\r\v\f\u0085\u2028\u2029]/g;

/** What a review shows of `about`, the whole input of a tool: its lines as the agent wrote them,
 *  breaks kept, controls and bidi out, up to `REVIEW_MAX` characters; `more` when it may be longer. */
export function reviewText(about: string): { text: string; more: boolean } {
  const all = [...about.replace(REVIEW_BREAKS, "\n").replace(REVIEW_UNSAFE, "")];
  return { text: all.slice(0, REVIEW_MAX).join("").replace(/^\n+|\s+$/g, ""), more: about.length >= REVIEW_MAX };
}

/** Answer `tile`'s wait. A late answer is told: someone answered first, or it waits no more. */
async function decide(tile: string, waiting: AgentWait, decision: "allow" | "deny"): Promise<void> {
  try {
    const { answered } = await window.hive.agentAnswer(tile, waiting.since, { decision });
    if (!answered) toast("It was answered already");
  } catch (e) {
    toast(`Could not answer: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Whether the text of `el` is cut where it shows: measured as it lays out, and again as it is
 *  resized. */
export function useCut(el: RefObject<HTMLElement | null>, text: string, on: boolean): boolean {
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const node = el.current;
    if (!on || !node) return undefined;
    const measure = () => setCut(node.scrollWidth > node.clientWidth + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    return () => ro.disconnect();
  }, [el, text, on]);
  return cut;
}

/** Whether these buttons take a press yet: not in their first `ARM_MS`. Until then they say they
 *  are disabled (`aria-disabled`), and still take the keyboard's focus. */
function useArmed(): boolean {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setArmed(true), ARM_MS);
    return () => clearTimeout(t);
  }, []);
  return armed;
}

/** Deny and Allow for `tile`'s wait, or Review when what it allows is not all in sight (`cut`, the
 *  input not `inSight`, or a view's slot: `reviewOnly`). Compact 28px buttons; a press here never
 *  reaches the row or card beneath. Each wait gets its own (keyed by its `since`). */
export function DecideButtons(props: {
  tile: string; waiting: AgentWait; cut: boolean;
  /** The tile's name, said in the review where the band does not stand beside it. */
  name?: string;
  /** Review alone, never Allow in one click: for a place a view laid out. */
  reviewOnly?: boolean;
  /** 20px buttons, for a line slot a view made too low for 28px ones. */
  small?: boolean;
  className?: string;
}) {
  return <WaitButtons key={props.waiting.since} {...props} />;
}

function WaitButtons({ tile, waiting, cut, name, reviewOnly = false, small = false, className = "" }: Parameters<typeof DecideButtons>[0]) {
  const size = small ? "2xs" : "sm";
  const [busy, setBusy] = useState(false);
  const review = useRef<HTMLButtonElement>(null);
  const [reviewing, setReviewing] = useState(false);
  const armed = useArmed();
  const run = (decision: "allow" | "deny") => {
    setBusy(true);
    void decide(tile, waiting, decision).finally(() => setBusy(false));
  };
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
  return (
    <span className={`flex gap-1.5 ${className}`} data-layer-decide onClick={stop} onKeyDown={stop}>
      {reviewOnly || cut || !inSight(waiting.tool?.about ?? "") ? (
        <>
          <Button ref={review} size={size} variant="ghost" aria-expanded={reviewing} onClick={() => setReviewing((r) => !r)} data-decide="review">Review</Button>
          {reviewing && <WaitReview tile={tile} name={name} waiting={waiting} anchor={review} busy={busy} run={run} close={() => setReviewing(false)} />}
        </>
      ) : (
        <>
          <Button size={size} variant="ghost" disabled={busy} aria-disabled={!armed || undefined} onClick={() => armed && run("deny")} data-decide="deny">Deny</Button>
          <Button size={size} disabled={busy} aria-disabled={!armed || undefined} onClick={() => armed && run("allow")} data-decide="allow">Allow</Button>
        </>
      )}
    </span>
  );
}

/** The whole of what a wait asks to run, beside `anchor`, with Deny and Allow: the keyboard lands
 *  on Deny, and a press in its first half second answers nothing. Closes on Escape, a press outside
 *  it, or an answer; closed by another wait in its place, it says the request changed. */
function WaitReview({ tile, name, waiting, anchor, busy, run, close }: {
  tile: string; name?: string; waiting: AgentWait; anchor: RefObject<HTMLElement | null>; busy: boolean; run: (d: "allow" | "deny") => void; close: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const deny = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const armed = useArmed();
  useLayoutEffect(() => {
    const r = anchor.current?.getBoundingClientRect();
    if (!r) return;
    setAt({ top: Math.max(8, Math.min(r.bottom + 6, window.innerHeight - 260)), left: Math.max(8, Math.min(r.left, window.innerWidth - 368)) });
  }, [anchor]);
  useEffect(() => { if (at) deny.current?.focus(); }, [at]);
  useEffect(() => {
    const out = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node) && !anchor.current?.contains(e.target as Node)) close();
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    document.addEventListener("mousedown", out);
    document.addEventListener("keydown", esc, true);
    return () => { document.removeEventListener("mousedown", out); document.removeEventListener("keydown", esc, true); };
  }, [anchor, close]);
  // Gone while open: when the tile waits on something else now, or no more, the person is told.
  useEffect(() => () => {
    const now = waitOf(tile)?.waiting;
    if (now?.since !== waiting.since) toast(now ? "The request changed: review it again" : "It no longer waits");
  }, [tile, waiting.since]);
  if (!at) return null;
  const { text, more } = reviewText(waiting.tool?.about ?? "");
  const tool = oneLine(waiting.tool?.name ?? "");
  const where = name ? oneLine(name) : "";
  const answer = (d: "allow" | "deny") => { if (!armed) return; run(d); close(); };
  return createPortal(
    <div ref={box} role="dialog" aria-label={`Allow ${tool}${where ? ` in ${where}` : ""}?`} data-wait-review={tile}
      className="hm-popover fixed z-(--layer-notifications) w-[360px]" style={at}
      onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <div className="px-3 pt-2.5 pb-3">
        <p className="truncate text-label font-medium text-[var(--color-fg)]">
          {tool}{where && <span className="font-normal text-[var(--color-fg2)]" data-wait-review-tile> · {where}</span>}
        </p>
        {/* What an agent wrote: text only, never markup; its line breaks kept, nothing cut per line. */}
        <pre className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-[var(--color-bg3)] px-2 py-1.5 font-mono text-count leading-4 text-[var(--color-fg)]">
          {text}
        </pre>
        {more && <p className="mt-1 text-count text-[var(--color-fg3)]" data-wait-review-more>Only its first {REVIEW_MAX.toLocaleString()} characters are shown: open the tile to read all of it.</p>}
        <div className="mt-2.5 flex justify-end gap-1.5">
          <Button ref={deny} size="sm" variant="ghost" disabled={busy} aria-disabled={!armed || undefined} onClick={() => answer("deny")} data-decide="deny">Deny</Button>
          <Button size="sm" disabled={busy} aria-disabled={!armed || undefined} onClick={() => answer("allow")} data-decide="allow">Allow</Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
