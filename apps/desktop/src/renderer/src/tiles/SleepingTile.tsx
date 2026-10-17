import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { toPtyId } from "@hivemind/workspace-api/tile-id";
import type { SavedScreen } from "@hivemind/workspace-api/terminals";
import { Button } from "../components/ui/button";
import { GripVertical, Moon, Play } from "../components/icons";
import { getTheme, useTheme } from "../theme-store";
import { useTileFont } from "../tile-font";
import { scaleToFit } from "../pty-size-sync";
import { DEFAULT_FONT, termBgFor, terminalLook } from "../terminal-look";
import { drawSaved } from "./saved-screen";

/** The newest lines of its saved screen it shows. */
const SAVED_LINES = 1000;

interface Props {
  tileId: string;
  name?: string;
  /** Its layout says it sleeps (an exit or an open can say so first). */
  sleeping: boolean;
  onWake: () => Promise<void>;
  onClose?: () => void;
}

/** An agent put to sleep: its name and its last screen, dimmed and still, with Resume. Nothing runs:
 *  its screen is drawn once by a terminal that takes no keys, as the live one drew it. */
export function SleepingTile({ tileId, name, sleeping, onWake, onClose }: Props) {
  const theme = useTheme();
  const font = useTileFont(tileId, DEFAULT_FONT);
  const hostRef = useRef<HTMLDivElement>(null);
  const [saved, setSaved] = useState<SavedScreen | null>(null);
  const [waking, setWaking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Read again when the layout says it sleeps: an exit that said so may come before its screen.
  useEffect(() => {
    let live = true;
    void window.hive.ptySaved(toPtyId(tileId), SAVED_LINES).then((s) => { if (live && s) setSaved(s); }, () => {});
    return () => { live = false; };
  }, [tileId, sleeping]);

  const background = termBgFor(theme);
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !saved) return;
    const term = new Terminal({ ...terminalLook(font.size, getTheme()), disableStdin: true, cursorBlink: false, scrollback: SAVED_LINES });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    if (term.element) term.element.style.transformOrigin = "0 0";
    void drawSaved(term, saved);
    // Larger than the tile, it is scaled down to fit, as a live one sized elsewhere is.
    const place = () => {
      const own = fit.proposeDimensions();
      const scale = own ? scaleToFit(own, saved) : 1;
      if (term.element) term.element.style.transform = scale < 1 ? `scale(${scale})` : "";
    };
    place();
    const seen = new ResizeObserver(place);
    seen.observe(host);
    return () => { seen.disconnect(); term.dispose(); };
  }, [saved, font.size, theme.terminal, background]);

  const resume = () => {
    setWaking(true);
    setError(null);
    onWake().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))).finally(() => setWaking(false));
  };

  return (
    <div className="flex h-full flex-col rounded-xl border border-[var(--color-line)] bg-[var(--color-bg2)] overflow-hidden shadow-[var(--hm-shadow-float)]" data-sleeping>
      <div data-tile-titlebar className="tile-drag-handle h-8 flex items-center gap-2 px-2.5 bg-[var(--color-bg3)] border-b border-[var(--color-line)] text-count font-mono text-[var(--color-fg2)] cursor-grab active:cursor-grabbing">
        <GripVertical size={13} className="text-[var(--color-fg3)] -ml-1 shrink-0" />
        <span className="font-semibold text-[var(--color-fg)] truncate">{name?.trim() || "Agent"}</span>
        <span className="inline-flex items-center gap-1 text-[var(--color-fg3)]"><Moon size={12} />Asleep</span>
        <Button variant="ghost" size="micro" className="nodrag ml-auto" onClick={resume} disabled={waking} aria-label="resume agent">
          <Play size={12} />{waking ? "Resuming…" : "Resume"}
        </Button>
        <Button variant="ghost" size="icon-micro" className="nodrag" aria-label="close tile" title="close tile" onClick={() => onClose?.()}>
          ×
        </Button>
      </div>
      <div className="hm-term-host relative flex-1 min-h-0 min-w-0 overflow-hidden bg-[var(--color-terminal-bg)] p-1.5">
        <div ref={hostRef} className="h-full w-full overflow-hidden opacity-45 saturate-50" />
        {error && (
          <div role="alert" className="absolute inset-x-2 bottom-2 rounded-md bg-[var(--color-bg3)] px-2 py-1 text-count text-[var(--color-fg)]">{error}</div>
        )}
      </div>
    </div>
  );
}
