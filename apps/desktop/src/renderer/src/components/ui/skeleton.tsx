import { cn } from "../../lib/cn"

/**
 * A placeholder the shape of the thing that is coming. It paints one step above the
 * surface it sits on, never with a semantic colour — a skeleton says "not yet", not
 * "something happened". The pulse is motion-safe: with reduced motion it holds still,
 * because the shape alone already carries the meaning.
 */
const SHAPE = {
  default: "rounded-md",
  chip: "rounded-sm",
  pill: "rounded-full",
  panel: "rounded-lg",
} as const

function Skeleton({ className, shape = "default", ...props }: React.ComponentProps<"div"> & { shape?: keyof typeof SHAPE }) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("bg-[var(--color-bg3)] motion-safe:animate-pulse", SHAPE[shape], className)}
      {...props}
    />
  )
}

export { Skeleton }
