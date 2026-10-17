import { useState } from "react";
import { Button } from "../components/ui/button";
import { GripVertical, Moon, Play } from "../components/icons";
import { useThemeField } from "../theme-store";

interface Props {
  name?: string;
  onWake: () => Promise<void>;
  onClose?: () => void;
}

/** An agent put to sleep: its name and Resume on the terminal's background. Nothing runs. */
export function SleepingTile({ name, onWake, onClose }: Props) {
  const palette = useThemeField("terminal");
  const [waking, setWaking] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        <Button variant="ghost" size="icon-micro" className="nodrag ml-auto" aria-label="close tile" title="close tile" onClick={() => onClose?.()}>
          ×
        </Button>
      </div>
      <div className="relative flex-1 min-h-0 flex items-center justify-center" style={{ color: palette.foreground, background: palette.background }}>
        <Button variant="outline" size="sm" className="nodrag" onClick={resume} disabled={waking} aria-label="resume agent">
          <Play size={14} />{waking ? "Resuming…" : "Resume"}
        </Button>
        {error && (
          <div role="alert" className="absolute inset-x-2 bottom-2 rounded-md bg-[var(--color-bg3)] px-2 py-1 text-count text-[var(--color-fg)]">{error}</div>
        )}
      </div>
    </div>
  );
}

