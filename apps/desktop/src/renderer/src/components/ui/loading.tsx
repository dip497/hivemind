import { useEffect, useState, type ReactNode } from "react";
import { Spinner } from "../icons";
import { cn } from "../../lib/cn";

/** How long a wait goes unremarked: a load quicker than this never flashes a message. */
export const LOADING_DELAY_MS = 300;

/** `children` once the wait has lasted LOADING_DELAY_MS, nothing before. */
export function Delayed({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShown(true), LOADING_DELAY_MS);
    return () => clearTimeout(t);
  }, []);
  return shown ? children : null;
}

/** Something is on its way: a spinner in the middle of the space it fills, and what it waits for,
 *  once the wait is long enough to notice. */
export function Loading({ label, className }: { label?: string; className?: string }) {
  return (
    <div role="status" aria-live="polite" className={cn("flex h-full min-h-16 w-full flex-col items-center justify-center gap-2 text-[11.5px] text-[var(--color-fg3)]", className)}>
      <Delayed>
        <div data-loading className="contents">
          <Spinner className="size-4 animate-spin" aria-hidden />
          <span>{label ?? "Loading"}</span>
        </div>
      </Delayed>
    </div>
  );
}
