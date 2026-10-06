import { tileKind } from "./api";

/** A kind's mark in a tab strip or the Layers panel: its icon, else its monochrome glyph. */
export function KindMark({ kind, size = 12 }: { kind: string; size?: number }) {
  const { icon: Icon, glyph } = tileKind(kind);
  if (Icon) return <Icon size={size} />;
  return <span aria-hidden className="font-mono text-[11px] text-[var(--color-fg3)]">{glyph ?? "▢"}</span>;
}
