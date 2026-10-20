import * as React from "react"
import { cn } from "../../lib/cn"

/** A box that tells the person something about the space it sits in: a title, then plain lines. */
function Alert({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert"
      role="note"
      className={cn("grid w-full gap-1 rounded-md border border-[var(--color-line2)] bg-[var(--color-bg2)] px-4 py-3 text-label", className)}
      {...props}
    />
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="alert-title" className={cn("font-medium text-[var(--color-fg)]", className)} {...props} />
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="alert-description" className={cn("grid gap-1 text-[var(--color-fg2)]", className)} {...props} />
}

export { Alert, AlertTitle, AlertDescription }
