import * as React from "react"
import { cn } from "../../lib/cn"

function Textarea({ className, font = "sans", ...props }: React.ComponentProps<"textarea"> & { font?: "sans" | "mono" }) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-md border border-input bg-background px-2.5 py-2 text-[13px] text-foreground outline-none transition-[border-color,box-shadow] duration-[var(--hm-dur-2)] placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-45 aria-invalid:border-destructive",
        font === "mono" && "font-mono",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
