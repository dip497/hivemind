/** A long list draws its first rows and a button for the next ones, so a list of thousands stays quick. */
import { useState } from "react";
import { cn } from "../../lib/cn";

/** How many rows to draw: `first` to start, `step` more each time `more` is called, `first` again
 *  when `reset` changes (a new search). */
export function useShowMore(first: number, step = first, reset?: unknown): [number, () => void] {
  const [state, setState] = useState({ reset, limit: first });
  const limit = Object.is(state.reset, reset) ? state.limit : first;
  return [limit, () => setState({ reset, limit: limit + step })];
}

/** "Show 25 more" under a list, with how many are left; nothing when none are. `size="sm"` under a list of
 *  compact rows (the branch picker). */
export function ShowMore({ left, step, onClick, size = "default", className }: { left: number; step: number; onClick: () => void; size?: "default" | "sm"; className?: string }) {
  if (left <= 0) return null;
  return <button type="button" data-show-more onClick={onClick}
    className={cn("flex h-7 items-center rounded-md px-2 text-label text-[var(--color-fg2)] hover:text-[var(--color-fg)]", size === "sm" && "text-chip", className)}>
    Show {Math.min(step, left)} more<span className="ml-1.5 tabular-nums text-count">· {left} left</span>
  </button>;
}
