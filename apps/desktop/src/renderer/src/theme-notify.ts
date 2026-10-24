/**
 * Telling a terminal program the background went light or dark, after it started.
 *
 * Agent TUIs read the terminal's background once, at launch (OSC 11, or `COLORFGBG`), and pick
 * their colours from it. Switching Settings → Appearance to light then leaves them drawing dark
 * text for a dark page. Two ways a program finds out, both answered here:
 *
 * - `COLORFGBG`, set when the session starts: `15;0` (light text on black) or `0;15`.
 * - DEC private mode 2031, colour palette update notifications (contour, kitty, ghostty, neovim;
 *   Claude Code enables it): a program sends `CSI ? 2031 h`, and from then the terminal sends
 *   `CSI ? 997 ; 1 n` (dark) or `CSI ? 997 ; 2 n` (light) when the background changes. `CSI ? 996 n`
 *   asks for it now. `CSI ? 2031 l` stops it.
 */

export const THEME_NOTIFY_MODE = 2031;
/** The device status request that asks which it is now. */
export const THEME_QUERY = 996;

/** What the terminal says it is: `CSI ? 997 ; 1 n` for dark, `2` for light. */
export const themeReport = (dark: boolean): string => `\x1b[?997;${dark ? 1 : 2}n`;

/** `COLORFGBG` for a session started on this background: the 16-colour numbers of its text and
 *  its background, white (15) on black (0) or the other way round. */
export const colorFgBg = (dark: boolean): string => (dark ? "15;0" : "0;15");

/** Whether `hex` (`#rgb` or `#rrggbb`) is a dark background: its relative luminance under the
 *  midpoint between black and white by contrast (0.179). Anything unreadable counts as dark, the
 *  terminal's own default. */
export function isDarkBackground(hex: string): boolean {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return true;
  const h = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join("") : m[1]!;
  const lin = (i: number) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4) < 0.179;
}

/** One terminal's mode 2031: whether its program asked, and what it was last told. Each method
 *  returns what to send the program, or null. A window keeps one for as long as it shows the
 *  session; a window that attaches later learns the mode from the daemon's replay
 *  (`themeNotifySeq` in the screen worker). */
export class ThemeNotify {
  private on = false;
  constructor(private dark: boolean) {}

  /** `CSI ? … h` (`set`) or `l`: the program switches modes, maybe 2031 among them. Turned on, it
   *  hears where the background is now: it may have changed while no window that heard the
   *  program ask had the keys (an app restart, a reload, another window holding them). */
  mode(params: readonly (number | number[])[], set: boolean): string | null {
    if (!params.includes(THEME_NOTIFY_MODE)) return null;
    const was = this.on;
    this.on = set;
    return set && !was ? themeReport(this.dark) : null;
  }

  /** `CSI ? … n`: the answer to a query for this mode, whether or not it is on. */
  query(params: readonly (number | number[])[]): string | null {
    return params[0] === THEME_QUERY ? themeReport(this.dark) : null;
  }

  /** The terminal's background is now `dark` or not: a report when it changed and was asked for. */
  theme(dark: boolean): string | null {
    if (dark === this.dark) return null;
    this.dark = dark;
    return this.on ? themeReport(dark) : null;
  }

  /** What to tell the program as this window gains the keys: where the background is, if it asked. */
  now(): string | null {
    return this.on ? themeReport(this.dark) : null;
  }

  /** The program ended: the next one in the session asks for itself. */
  reset(): void {
    this.on = false;
  }
}

/** The part of xterm's parser this needs: the one `Terminal.parser` of the app's xterm and of a
 *  headless one. */
interface CsiParser {
  registerCsiHandler(id: { prefix?: string; final: string }, cb: (params: (number | number[])[]) => boolean | Promise<boolean>): { dispose(): void };
}

/** Hear a terminal's program set and clear mode 2031 and ask for it (`CSI ? 996 n`), answering
 *  through `send` (a set is answered with where the background is now). A mode set is left to xterm too (false), so the other modes in it still apply. */
export function answerThemeNotify(parser: CsiParser, notify: ThemeNotify, send: (reply: string) => void): void {
  parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
    const reply = notify.mode(params, true);
    if (reply) send(reply);
    return false;
  });
  parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => { notify.mode(params, false); return false; });
  parser.registerCsiHandler({ prefix: "?", final: "n" }, (params) => {
    const reply = notify.query(params);
    if (reply) send(reply);
    return reply !== null;
  });
}
