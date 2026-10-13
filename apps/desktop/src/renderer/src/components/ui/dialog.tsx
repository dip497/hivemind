"use client"

import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "../icons"

import { cn } from "../../lib/cn"

const Dialog = DialogPrimitive.Root

const DialogTrigger = DialogPrimitive.Trigger

const DialogPortal = DialogPrimitive.Portal

const DialogClose = DialogPrimitive.Close

// Closing, it fades out over a page that is live again: the click is the page's (important, as
// the overlay sets its pointer-events inline). It lasts as long as the content's, in a portal of its
// own: gone first and opened again, it would come back above the content.
const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 hm-modal-overlay duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:pointer-events-none! data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    /** "none" for a dialog that lays out its own header/body/footer edge to edge. */
    padding?: "default" | "none"
    /** The × in its corner; a dialog that is all list, closed with Escape or a click outside, has none. */
    closeButton?: boolean
  }
>(({ className, children, padding = "default", closeButton = true, onPointerDownOutside, ...props }, ref) => {
  // A press begun while it was closing is no press outside it: its click may be what opened it again.
  const node = React.useRef<HTMLDivElement | null>(null)
  const pressedClosed = React.useRef(false)
  React.useEffect(() => {
    const down = () => { pressedClosed.current = node.current?.dataset.state === "closed" }
    document.addEventListener("pointerdown", down, true)
    return () => document.removeEventListener("pointerdown", down, true)
  }, [])
  const refs = React.useCallback((el: HTMLDivElement | null) => {
    node.current = el
    if (typeof ref === "function") ref(el)
    else if (ref) ref.current = el
  }, [ref])
  return <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={refs}
      onPointerDownOutside={(e) => { if (pressedClosed.current) e.preventDefault(); onPointerDownOutside?.(e) }}
      className={cn(
        "fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:pointer-events-none data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] hm-surface-3 text-[var(--color-fg)]",
        padding === "none" ? "gap-0 p-0" : "gap-4 p-6",
        className
      )}
      {...props}
    >
      {children}
      {closeButton && <DialogPrimitive.Close className="absolute right-4 top-4 grid place-items-center size-7 rounded-md text-[var(--color-fg3)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg3)] transition-opacity focus:outline-none focus:ring-2 focus:ring-[var(--color-brand)] disabled:pointer-events-none cursor-pointer">
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>}
    </DialogPrimitive.Content>
  </DialogPortal>
})
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-1.5 text-center sm:text-left",
      className
    )}
    {...props}
  />
)
DialogHeader.displayName = "DialogHeader"

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
      className
    )}
    {...props}
  />
)
DialogFooter.displayName = "DialogFooter"

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-row font-medium leading-none tracking-tight text-foreground",
      className
    )}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-label text-muted-foreground", className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
