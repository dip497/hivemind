type Named = { id: string; label?: string; task?: string };

/** What a tile is called, everywhere it is shown: the name someone gave it, else what it is
 *  doing (what its agent says, else what it was started to do), else its label. The label is
 *  the fallback, not a prefix — "claude #3" says nothing a glance at the tile does not. */
export function tileName(names: Readonly<Record<string, string>>, titles: Readonly<Record<string, string>>, t: Named & { label: string }): string;
export function tileName(names: Readonly<Record<string, string>>, titles: Readonly<Record<string, string>>, t: Named): string | undefined;
export function tileName(names: Readonly<Record<string, string>>, titles: Readonly<Record<string, string>>, t: Named): string | undefined {
  return names[t.id] || titles[t.id] || t.task || t.label;
}
