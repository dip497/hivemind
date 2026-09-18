import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "../../lib/cn"

/**
 * One row of a popover list or menu: a full-width target that reads as a row, not a button.
 * Kept as a plain <button> so the surrounding popover keeps its own positioning and keyboard
 * handling — this owns how a row LOOKS, nothing else.
 */
const menuItemVariants = cva(
  "flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md text-left text-[12px] outline-none transition-[background-color,color] duration-[var(--hm-dur-2)] focus-visible:bg-secondary disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        default: "text-foreground hover:bg-secondary",
        muted: "text-muted-foreground hover:bg-secondary hover:text-foreground",
        destructive: "text-destructive hover:bg-destructive/10",
      },
      size: {
        default: "px-2 py-1.5",
        sm: "px-2 py-1",
        xs: "px-2 py-1 text-[11px]",
      },
      selected: {
        true: "bg-secondary text-foreground",
        false: "",
      },
    },
    defaultVariants: { variant: "default", size: "default", selected: false },
  }
)

function MenuItem({
  className,
  variant,
  size,
  selected,
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof menuItemVariants>) {
  return (
    <button
      type="button"
      data-slot="menu-item"
      data-selected={selected ? "" : undefined}
      className={cn(menuItemVariants({ variant, size, selected, className }))}
      {...props}
    />
  )
}

export { MenuItem, menuItemVariants }
