/**
 * The answer to a program asking the terminal what colour its background is
 * (OSC 11 `?`).
 *
 * With glass on, the terminal's background is `rgba(0,0,0,0)` so the wallpaper
 * shows through, and xterm reports that as black. TUIs that tint their own
 * panels from it (codex's composer is the reported background lightened a
 * notch) then draw grey boxes over the wallpaper. The theme's own background is
 * what the user picked and what those panels should blend towards.
 */
export function oscColorReply(hex: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const lc = m[1]!.toLowerCase();
  const h = lc.length === 3 ? [...lc].map((c) => c + c).join("") : lc;
  // X11 form, 16 bits a channel: each byte doubled, as xterm itself answers.
  const ch = (i: number) => h.slice(i, i + 2).repeat(2);
  return `rgb:${ch(0)}/${ch(2)}/${ch(4)}`;
}
