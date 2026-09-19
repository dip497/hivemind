import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "../../lib/cn"
import { Slot } from "@radix-ui/react-slot"

const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md text-[13px] font-medium whitespace-nowrap outline-none transition-[background-color,color,opacity,scale] duration-[var(--hm-dur-2)] ease-[var(--hm-ease-out)] active:scale-[0.96] active:duration-[var(--hm-dur-1)] focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline: "border border-input bg-transparent text-foreground hover:bg-secondary",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "text-muted-foreground hover:bg-secondary hover:text-foreground",
        /* A remove/detach control: quiet until you reach it, then it says what it does. */
        "ghost-destructive": "text-muted-foreground hover:bg-destructive/10 hover:text-destructive",
        link: "px-0 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline active:scale-100",
      },
      /** Machine output (paths, counts, commands) is mono, and numbers line up. */
      font: {
        sans: "",
        mono: "font-mono tabular-nums",
      },
      /** Tile/row chrome that stays out of the way until the row is hovered or focused. */
      reveal: {
        none: "",
        dim: "opacity-40 group-hover:opacity-100 focus-visible:opacity-100",
        hidden: "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
      },
      size: {
        default: "h-8 px-3",
        xs: "h-6 gap-1 rounded-sm px-2 text-[11px]",
        /* Tile and canvas chrome, where a taller control would move the layout. */
        "2xs": "h-5 gap-1 rounded-sm px-1.5 text-[10.5px] [&_svg:not([class*='size-'])]:size-3",
        micro: "h-4 gap-0.5 rounded-sm px-1 text-[10px] [&_svg:not([class*='size-'])]:size-2.5",
        sm: "h-7 px-2.5 text-xs",
        lg: "h-9 px-4",
        icon: "size-8",
        "icon-xs": "size-6 rounded-sm",
        "icon-2xs": "size-5 rounded-sm [&_svg:not([class*='size-'])]:size-3",
        "icon-micro": "size-4 rounded-sm [&_svg:not([class*='size-'])]:size-2.5",
        "icon-sm": "size-7",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
      font: "sans",
      reveal: "none",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  font = "sans",
  reveal = "none",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, font, reveal, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
