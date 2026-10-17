// Held and swiped rows: one set of listeners on a list's root, none on a row, so a list of 200
// costs nothing until touched.

/** Calls `then` with what was pressed once a press is held still for `HOLD_MS` (hapi's
 *  useLongPress.ts:48-111); when `then` takes it, the click that ends the press is swallowed. */
export function onHold(root: HTMLElement, then: (target: Element) => boolean): void {
  let timer = 0;
  let held = false;
  let at: Element | null = null;
  let x = 0;
  let y = 0;
  const hold = () => {
    clearTimeout(timer);
    held = !!at && then(at);
  };
  root.addEventListener("pointerdown", (e) => {
    held = false;
    at = e.target instanceof Element ? e.target : null;
    if (e.button !== 0) return;
    x = e.clientX;
    y = e.clientY;
    timer = window.setTimeout(hold, HOLD_MS);
  });
  root.addEventListener("pointermove", (e) => {
    if (Math.hypot(e.clientX - x, e.clientY - y) > SLOP) clearTimeout(timer);
  });
  for (const end of ["pointerup", "pointercancel"]) root.addEventListener(end, () => clearTimeout(timer));
  // A right click, and Android's own long press.
  root.addEventListener("contextmenu", (e) => {
    if (held) return e.preventDefault();
    at = e.target instanceof Element ? e.target : null;
    hold();
    if (held) e.preventDefault();
  });
  root.addEventListener("click", (e) => {
    if (!held) return;
    held = false;
    e.stopPropagation();
  }, { capture: true });
}

/** A row (`selector`, `touch-action: pan-y`) dragged left slides its first child over the actions
 *  `behind` makes for it; let go past half of them it stays open, as Happy's Swipeable rows do
 *  (FlatSessionRow.tsx:259-276). One row open at a time; a press anywhere but its actions shuts it. */
export function onSwipe(root: HTMLElement, selector: string, behind: (row: HTMLElement) => HTMLElement): { shut(): void } {
  let row: HTMLElement | null = null;
  let open: HTMLElement | null = null;
  let actions: HTMLElement | null = null;
  let x0 = 0;
  let y0 = 0;
  let from = 0;
  let at = 0;
  let dragging = false;
  let dragged = false;
  const slide = (to: number, eased: boolean) => {
    const face = open!.firstElementChild as HTMLElement;
    face.style.transition = eased ? "transform 180ms ease-out" : "none";
    face.style.transform = to ? `translateX(${to}px)` : "";
    at = to;
  };
  const shut = () => {
    if (!open) return;
    const was = open;
    const gone = actions;
    slide(0, true);
    open = actions = null;
    setTimeout(() => {
      if (open === was) return;
      gone?.remove();
      was.removeAttribute("data-swiped");
    }, 200);
  };
  root.addEventListener("pointerdown", (e) => {
    const target = e.target instanceof Element ? e.target : null;
    dragging = false;
    // Open, a press anywhere but its actions shuts it; on the row itself, that is all it does.
    dragged = !!open && !!target && open.contains(target) && !actions?.contains(target);
    if (open && !(target && actions?.contains(target))) {
      shut();
      row = null;
      return;
    }
    row = target?.closest<HTMLElement>(selector) ?? null;
    x0 = e.clientX;
    y0 = e.clientY;
  });
  root.addEventListener("pointermove", (e) => {
    if (!row) return;
    const dx = e.clientX - x0;
    const dy = e.clientY - y0;
    if (!dragging) {
      if (Math.abs(dy) > SLOP && Math.abs(dy) > Math.abs(dx)) return void (row = null);
      if (Math.abs(dx) <= SLOP) return;
      dragging = dragged = true;
      if (open !== row) {
        shut();
        open = row;
        actions = behind(row);
        row.setAttribute("data-swiped", "");
        row.append(actions);
        at = 0;
      }
      from = at;
    }
    slide(Math.min(0, Math.max(-actions!.offsetWidth, from + dx)), false);
  });
  const end = () => {
    row = null;
    if (!dragging) return;
    dragging = false;
    if (at < -actions!.offsetWidth / 2) slide(-actions!.offsetWidth, true);
    else shut();
  };
  root.addEventListener("pointerup", end);
  root.addEventListener("pointercancel", end);
  // A drag that ends where it started is no tap.
  root.addEventListener("click", (e) => {
    if (dragged) e.stopPropagation();
    dragged = false;
  }, { capture: true });
  return { shut };
}

const HOLD_MS = 500;
/** How far a press moves before it is a drag, not a press. */
const SLOP = 10;
