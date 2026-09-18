/**
 * What a tile looks like before its content is there: the same chrome, in grey.
 * Each kind gets its own shape so the canvas does not reflow when the real thing
 * arrives, and so a glance tells you WHICH tile is still coming.
 */
import { Skeleton } from "../components/ui/skeleton";

function Shell({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div
      role="status"
      aria-label={label}
      className="w-full h-full flex flex-col gap-2 overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-bg2)] p-3"
    >
      {children}
      <span className="sr-only">{label}</span>
    </div>
  );
}

/** Rows of text of uneven length, the way real lines of code or prose look. */
function Lines({ count, widths }: { count: number; widths?: string[] }) {
  const w = widths ?? ["w-11/12", "w-8/12", "w-10/12", "w-6/12", "w-9/12", "w-7/12"];
  return (
    <div className="flex flex-col gap-1.5">
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className={`h-2.5 ${w[i % w.length]}`} />
      ))}
    </div>
  );
}

export function DiffSkeleton() {
  return (
    <Shell label="Loading diff">
      <div className="flex items-center gap-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-16" />
        <Skeleton className="ml-auto h-4 w-10" />
      </div>
      <div className="grid flex-1 grid-cols-2 gap-3 overflow-hidden">
        <Lines count={9} />
        <Lines count={9} widths={["w-9/12", "w-11/12", "w-7/12", "w-10/12"]} />
      </div>
    </Shell>
  );
}

export function EditorSkeleton() {
  return (
    <Shell label="Loading editor">
      <div className="flex items-center gap-1.5">
        <Skeleton shape="chip" className="h-5 w-28" />
        <Skeleton shape="chip" className="h-5 w-16" />
      </div>
      <Lines count={12} />
    </Shell>
  );
}

export function BrowserSkeleton() {
  return (
    <Shell label="Loading browser">
      <div className="flex items-center gap-2">
        <Skeleton shape="chip" className="size-4" />
        <Skeleton shape="chip" className="size-4" />
        <Skeleton shape="pill" className="h-6 flex-1" />
      </div>
      <Skeleton shape="panel" className="flex-1" />
    </Shell>
  );
}

/** A list that is still loading: the rows it will have, not a spinner. */
export function RowsSkeleton({ rows = 4, className = "" }: { rows?: number; className?: string }) {
  return (
    <div role="status" aria-label="Loading" className={`flex flex-col gap-2 p-2 ${className}`}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-2">
          <Skeleton shape="chip" className="size-3.5 shrink-0" />
          <Skeleton className="h-3 flex-1" style={{ maxWidth: `${70 + ((i * 13) % 25)}%` }} />
        </div>
      ))}
      <span className="sr-only">Loading</span>
    </div>
  );
}
