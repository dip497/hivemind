/**
 * Allow and Deny, for an agent that waits on the person's permission to use a tool
 * (docs/design/last-line-2026-10-23.md §2, §3): in its Layers row and in its toast. They answer
 * `agent.answer` with the wait's `since`, so an answer that comes late (someone else answered, or
 * the agent stopped waiting) answers nothing and says so.
 *
 * Allowing is one click, so they are offered only when the person sees all of what they allow:
 * the tool's input is one line and none of it is cut where it shows. Otherwise the place offers
 * Review, which shows the whole input first, with Deny where the keyboard lands. A permission whose
 * agent says no more than the kind of wait offers neither: its tile shows what for.
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { oneLine } from "@hivemind/agent-host/one-line";
import { Button } from "./components/ui/button";
import type { AgentWait } from "./agent-waits";

/** The most of a tool's input a review shows (`agent.answer`'s summary is cut at the same). */
const REVIEW_MAX = 4000;

/** Whether `waiting` can be allowed or denied from here: a permission its agent says the keys of
 *  (`decide`), for a tool whose input is known. */
export function decidable(waiting: AgentWait | undefined): waiting is AgentWait & { tool: { name: string; about: string } } {
  return !!waiting && waiting.kind === "permission" && !!waiting.decide && !!waiting.tool?.name && !!waiting.tool.about?.trim();
}

/** Whether what `waiting` asks to run is one line: all of it is in the line that names it. */
const oneLined = (waiting: AgentWait): boolean => (waiting.tool?.about ?? "").trim().split("\n").length === 1;

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

/** Deny and Allow for `tile`'s wait, or Review when what it allows is not all in sight (`cut`, or
 *  more than one line). Compact 28px buttons; a press here never reaches the row or card beneath. */
export function DecideButtons({ tile, waiting, cut, small = false, className = "" }: {
  tile: string; waiting: AgentWait; cut: boolean;
  /** 20px buttons, for a line slot a view made too low for 28px ones. */
  small?: boolean;
  className?: string;
}) {
  const size = small ? "2xs" : "sm";
  const [busy, setBusy] = useState(false);
  const review = useRef<HTMLButtonElement>(null);
  const [reviewing, setReviewing] = useState(false);
  const run = (decision: "allow" | "deny") => {
    setBusy(true);
    void decide(tile, waiting, decision).finally(() => setBusy(false));
  };
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
  return (
    <span className={`flex gap-1.5 ${className}`} data-layer-decide onClick={stop} onKeyDown={stop}>
      {cut || !oneLined(waiting) ? (
        <>
          <Button ref={review} size={size} variant="ghost" aria-expanded={reviewing} onClick={() => setReviewing((r) => !r)} data-decide="review">Review</Button>
          {reviewing && <WaitReview tile={tile} waiting={waiting} anchor={review} busy={busy} run={run} close={() => setReviewing(false)} />}
        </>
      ) : (
        <>
          <Button size={size} variant="ghost" disabled={busy} onClick={() => run("deny")} data-decide="deny">Deny</Button>
          <Button size={size} disabled={busy} onClick={() => run("allow")} data-decide="allow">Allow</Button>
        </>
      )}
    </span>
  );
}

/** The whole of what a wait asks to run, beside `anchor`, with Deny and Allow: the keyboard lands
 *  on Deny. Closes on Escape, a press outside it, or an answer. */
function WaitReview({ tile, waiting, anchor, busy, run, close }: {
  tile: string; waiting: AgentWait; anchor: RefObject<HTMLElement | null>; busy: boolean; run: (d: "allow" | "deny") => void; close: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const deny = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
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
  if (!at) return null;
  const about = (waiting.tool?.about ?? "").slice(0, REVIEW_MAX);
  return createPortal(
    <div ref={box} role="dialog" aria-label={`Allow ${oneLine(waiting.tool?.name ?? "")}?`} data-wait-review={tile}
      className="hm-popover fixed z-(--layer-notifications) w-[360px]" style={at}
      onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <div className="px-3 pt-2.5 pb-3">
        <p className="text-label font-medium text-[var(--color-fg)]">{oneLine(waiting.tool?.name ?? "")}</p>
        {/* What an agent wrote: text only, never markup; its line breaks kept. */}
        <pre className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--color-bg3)] px-2 py-1.5 font-mono text-count leading-4 text-[var(--color-fg)]">
          {about.split("\n").map(oneLine).join("\n")}
        </pre>
        <div className="mt-2.5 flex justify-end gap-1.5">
          <Button ref={deny} size="sm" variant="ghost" disabled={busy} onClick={() => { run("deny"); close(); }} data-decide="deny">Deny</Button>
          <Button size="sm" disabled={busy} onClick={() => { run("allow"); close(); }} data-decide="allow">Allow</Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
