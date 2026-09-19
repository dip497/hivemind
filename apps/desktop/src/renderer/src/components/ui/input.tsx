import * as React from "react"
import { cn } from "../../lib/cn"

function Input({ className, type, font = "sans", size = "default", ...props }: Omit<React.ComponentProps<"input">, "size"> & { font?: "sans" | "mono"; size?: "default" | "sm" }) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "w-full min-w-0 rounded-md border border-input bg-background text-[13px] text-foreground outline-none transition-[border-color,box-shadow] duration-[var(--hm-dur-2)] selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground/70 disabled:cursor-not-allowed disabled:opacity-45",
        "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20",
        size === "sm" ? "h-7 px-2 text-[12px]" : "h-8 px-2.5",
        font === "mono" && "font-mono",
        className
      )}
      {...props}
    />
  )
}

export { Input }
