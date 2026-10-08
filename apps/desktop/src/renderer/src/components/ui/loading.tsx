import { Spinner } from "../icons";
import { cn } from "../../lib/cn";

/** Something is on its way: a spinner in the middle of the space it fills, and what it waits for. */
export function Loading({ label, className }: { label?: string; className?: string }) {
  return (
    <div role="status" aria-live="polite" data-loading className={cn("flex h-full min-h-16 w-full flex-col items-center justify-center gap-2 text-[11.5px] text-[var(--color-fg3)]", className)}>
      <Spinner className="size-4 animate-spin" aria-hidden />
      <span>{label ?? "Loading"}</span>
    </div>
  );
}
