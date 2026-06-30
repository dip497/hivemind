import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Shared anchored popover — trigger button + content panel that closes on
 * outside click or Escape. Uses the .hm-popover surface so every dropdown
 * (FilterBar, peek StateSelect, all pickers) reads as one family.
 *
 * Render-prop children receive a `close` callback so menu items can close
 * after a selection.
 */
export function Popover({
  trigger,
  children,
  width = 200,
  align = "right",
}: {
  trigger: ReactNode;
  children: (close: () => void) => ReactNode;
  width?: number;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} className="nodrag w-full text-left">
        {trigger}
      </button>
      {open && (
        <div
          className={`hm-popover absolute z-40 mt-1 ${align === "right" ? "right-0" : "left-0"}`}
          style={{ width }}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
