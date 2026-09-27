type Named = { id: string; label?: string; task?: string };

/** What a tile is called, everywhere it is shown: its name (one someone gave it, else its
 *  label), then what it is doing (what its agent says, else what it was started to do). */
export function tileName(names: Readonly<Record<string, string>>, titles: Readonly<Record<string, string>>, t: Named & { label: string }): string;
export function tileName(names: Readonly<Record<string, string>>, titles: Readonly<Record<string, string>>, t: Named): string | undefined;
export function tileName(names: Readonly<Record<string, string>>, titles: Readonly<Record<string, string>>, t: Named): string | undefined {
  const name = names[t.id] ?? t.label;
  const task = titles[t.id] || t.task;
  return name && task && task !== name ? `${name} · ${task}` : name ?? task;
}
