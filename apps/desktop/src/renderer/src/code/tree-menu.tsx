/**
 * A file tree's right-click menu, drawn in the page's own layer at the row it opened on. The tree
 * would draw it inside its tile, which the canvas moves and scales, so a menu placed for the page
 * landed off by the tile's place on the canvas, often outside the window. Portalled as the tree
 * allows (`data-file-tree-context-menu-root`), at the anchor's screen position, kept on screen.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ContextMenuOpenContext } from "@pierre/trees";

export function TreeMenu({ ctx, children }: { ctx: ContextMenuOpenContext; children: ReactNode }) {
  const el = useRef<HTMLDivElement>(null);
  const a = ctx.anchorRect;
  const [at, setAt] = useState({ left: a.left, top: a.bottom + 2 });
  useLayoutEffect(() => {
    const box = el.current?.getBoundingClientRect();
    if (!box) return;
    const left = Math.max(4, Math.min(a.left, innerWidth - box.width - 4));
    // Below the row when it fits, else above it.
    const top = a.bottom + 2 + box.height <= innerHeight - 4 ? a.bottom + 2 : Math.max(4, a.top - box.height - 2);
    setAt({ left, top });
  }, [a.left, a.top, a.bottom]);
  return createPortal(
    <div ref={el} data-file-tree-context-menu-root="true" style={{ position: "fixed", left: at.left, top: at.top, zIndex: 1000 }}>
      {children}
    </div>,
    document.body,
  );
}
