import { AppWindow } from "../components/icons";
import { tileKind } from "./api";

/** A kind's mark in a tab strip or the Layers panel: its icon, else the glyph its plugin chose,
 *  else a drawn window, never a stand-in character. */
export function KindMark({ kind, size = 12 }: { kind: string; size?: number }) {
  const { icon: Icon, glyph } = tileKind(kind);
  if (Icon) return <Icon size={size} />;
  if (glyph) return <span aria-hidden className="text-[11px] leading-none">{glyph}</span>;
  return <AppWindow size={size} />;
}
