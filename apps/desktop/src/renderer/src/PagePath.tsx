/**
 * The frame this window is inside (docs/design/canvas-pages-2026-11-24.md): what is outside it dims,
 * and the path in the tool island, `Workspace › Payments › Checkout`, has each part as a way back out.
 */
import { createContext, Fragment, useContext } from "react";
import { ChevronRight, PanelsTopLeft } from "./components/icons";
import { Button } from "./components/ui/button";

export interface FrameFocus {
  /** The frame the window is inside; null: the whole canvas. */
  frame: string | null;
  /** The frames from the top down to it, the focused one last. */
  path: ReadonlyArray<{ id: string; title: string; page: boolean }>;
  /** It and every frame inside it: what does not dim. Null: nothing dims. */
  members: ReadonlySet<string> | null;
  /** Fly to a frame and go inside it; null: out to the whole canvas. */
  enter: (id: string | null) => void;
  /** Out to the whole canvas where the camera is. */
  leave: () => void;
  /** The workspace's name, the path's first part. */
  workspace: string;
}

const WHOLE: FrameFocus = { frame: null, path: [], members: null, enter: () => {}, leave: () => {}, workspace: "Workspace" };

export const FrameFocusContext = createContext<FrameFocus>(WHOLE);

export function useFrameFocus(): FrameFocus {
  return useContext(FrameFocusContext);
}

/** The path to the frame the window is inside, at the start of the tool island; nothing on the whole canvas. */
export function PagePath() {
  const { frame, path, enter, workspace } = useFrameFocus();
  if (frame === null) return null;
  return (
    <>
      <nav aria-label="Page path" className="flex min-w-0 max-w-[min(520px,50vw)] items-center gap-0.5 overflow-hidden" data-page-path>
        <Button variant="ghost" size="xs" onClick={() => enter(null)} data-page-path-part="">{workspace}</Button>
        {path.map((p, i) => (
          <Fragment key={p.id}>
            <ChevronRight aria-hidden className="size-3 shrink-0 text-[var(--color-fg3)]" />
            {i === path.length - 1
              ? <span aria-current="page" className="flex min-w-0 items-center gap-1 truncate px-2 text-count font-semibold text-[var(--color-fg)]" data-page-path-part={p.id}>
                {p.page && <PanelsTopLeft aria-hidden className="size-3 shrink-0" />}{p.title}
              </span>
              : <Button variant="ghost" size="xs" onClick={() => enter(p.id)} data-page-path-part={p.id}>
                {p.page && <PanelsTopLeft aria-hidden className="size-3 shrink-0" />}{p.title}
              </Button>}
          </Fragment>
        ))}
      </nav>
      <div aria-hidden className="mx-1 h-5 w-px shrink-0 bg-[var(--color-line2)]" />
    </>
  );
}
