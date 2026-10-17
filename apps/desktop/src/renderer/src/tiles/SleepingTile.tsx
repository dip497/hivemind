import { useEffect, useState } from "react";
import { toPtyId } from "@hivemind/workspace-api/tile-id";
import { Button } from "../components/ui/button";
import { GripVertical, Moon, Play } from "../components/icons";
import { useThemeField } from "../theme-store";
import { savedScreenLines, type Run } from "./saved-screen";

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

/** An agent put to sleep: its name and its last screen, dimmed and still, with Resume. No live
 *  terminal: nothing runs, and its screen is drawn once as text. */
export function SleepingTile({ tileId, name, sleeping, onWake, onClose }: Props) {
  const palette = useThemeField("terminal");
  const [lines, setLines] = useState<Run[][] | null>(null);
  const [waking, setWaking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Read again when the layout says it sleeps: an exit that said so may come before its screen.
  useEffect(() => {
    let live = true;
    void window.hive.ptySaved(toPtyId(tileId), SAVED_LINES).then(
      async (saved) => { if (saved !== null) { const l = await savedScreenLines(saved, palette); if (live) setLines(l); } },
      () => {},
    );
    return () => { live = false; };
  }, [tileId, sleeping, palette]);

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
      <div className="relative flex-1 min-h-0">
        <pre
          className="absolute inset-0 m-0 overflow-auto p-2 font-mono text-body leading-[1.25] opacity-45 saturate-50 select-text flex flex-col-reverse"
          style={{ color: palette.foreground, background: palette.background }}
        >
          {/* Reversed, so it opens at its newest line as a terminal does. */}
          <div>
            {lines?.map((runs, i) => (
              <div key={i}>
                {runs.length ? runs.map((r, j) => <span key={j} style={styleOf(r)}>{r.text}</span>) : " "}
              </div>
            ))}
          </div>
        </pre>
        {error && (
          <div role="alert" className="absolute inset-x-2 bottom-2 rounded-md bg-[var(--color-bg3)] px-2 py-1 text-count text-[var(--color-fg)]">{error}</div>
        )}
      </div>
    </div>
  );
}

function styleOf(r: Run): React.CSSProperties | undefined {
  if (!r.color && !r.background && !r.bold && !r.faint && !r.italic && !r.underline) return undefined;
  return {
    ...(r.color ? { color: r.color } : {}),
    ...(r.background ? { background: r.background } : {}),
    ...(r.bold ? { fontWeight: 700 } : {}),
    ...(r.faint ? { opacity: 0.6 } : {}),
    ...(r.italic ? { fontStyle: "italic" } : {}),
    ...(r.underline ? { textDecoration: "underline" } : {}),
  };
}
