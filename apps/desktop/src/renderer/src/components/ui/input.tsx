import * as React from "react"
import { cn } from "../../lib/cn"

/** `size="list"`: the search over a list of label-size rows (the add dialog) reads at their size, at full control height. */
function Input({ className, type, font = "sans", size = "default", ...props }: Omit<React.ComponentProps<"input">, "size"> & { font?: "sans" | "mono"; size?: "default" | "sm" | "list" }) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "w-full min-w-0 rounded-md border border-input bg-background text-body text-foreground outline-none transition-[border-color,box-shadow] duration-[var(--hm-dur-2)] selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground/70 disabled:cursor-not-allowed disabled:opacity-45",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20",
        size === "sm" ? "h-control-compact px-2 text-label" : size === "list" ? "h-control px-2.5 text-label" : "h-control px-2.5",
        font === "mono" && "font-mono",
        className
      )}
      {...props}
    />
  )
}

export { Input }
