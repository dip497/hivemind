/** What a tile is called, everywhere it is shown: a name someone gave it (a rename, or the
 *  name its spawner chose), else what its agent says it is doing, else its label. */
export function tileName(names: Readonly<Record<string, string>>, titles: Readonly<Record<string, string>>, t: { id: string; label: string }): string;
export function tileName(names: Readonly<Record<string, string>>, titles: Readonly<Record<string, string>>, t: { id: string; label?: string }): string | undefined;
export function tileName(names: Readonly<Record<string, string>>, titles: Readonly<Record<string, string>>, t: { id: string; label?: string }): string | undefined {
  return names[t.id] ?? titles[t.id] ?? t.label;
}
