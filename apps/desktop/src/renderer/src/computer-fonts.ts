/**
 * The font families installed on this computer, for Appearance's font rows: read from the
 * browser's local font list once, the first time a font list is opened (it needs that click), and
 * again after a read that failed. A family is monospace when every letter measures the same width.
 */
export interface ComputerFont { family: string; mono: boolean }

let read: Promise<ComputerFont[]> | null = null;

export function computerFonts(): Promise<ComputerFont[]> {
  read ??= list().catch(() => {
    read = null;
    return [];
  });
  return read;
}

async function list(): Promise<ComputerFont[]> {
  const query = (window as { queryLocalFonts?: () => Promise<Array<{ family: string }>> }).queryLocalFonts;
  if (!query) return [];
  // A family is written into a CSS font list in double quotes; one that holds a quote or a backslash
  // cannot be, and no real font is named so.
  const families = [...new Set((await query.call(window)).map((f) => f.family.trim()))]
    .filter((f) => f && !/["\\]/.test(f))
    .sort((a, b) => a.localeCompare(b));
  const ctx = document.createElement("canvas").getContext("2d");
  const width = (family: string, text: string) => {
    ctx!.font = `16px "${family}", serif`;
    return ctx!.measureText(text).width;
  };
  return families.map((family) => ({
    family,
    mono: !!ctx && width(family, "iiiiiiiiii") === width(family, "WWWWWWWWWW") && width(family, "llllllllll") === width(family, "mmmmmmmmmm"),
  }));
}
