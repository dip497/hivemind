/**
 * The brand page's colours, motion and tracking come from the APP's stylesheet, read at build
 * time. The app is canonical; this site vendors it. A token renamed in the renderer either
 * shows up here on the next build or fails the build — it cannot quietly drift.
 */
import data from "../generated/tokens.json";

const SOURCE = data.source;

export interface Token {
  /** The custom property, without the leading dashes. */
  name: string;
  value: string;
  /** The trailing `/* … *​/` on the declaration, which is where the app keeps its reasoning. */
  note?: string;
}

/** Every `--name: value;` in the file, with the comment that trails it on the same line. */
function declarations(): Map<string, Token> {
  return new Map(Object.entries(data.tokens as Record<string, Token>));
}

const all = declarations();

const pick = (names: string[]): Token[] =>
  names.map((n) => all.get(n)).filter((t): t is Token => Boolean(t));

const byPrefix = (prefix: string): Token[] =>
  [...all.values()].filter((t) => t.name.startsWith(prefix));

/** A colour a browser can paint: `var(--x)` chains are followed to the value they land on. */
export function resolve(value: string): string {
  let v = value;
  for (let hop = 0; hop < 4 && v.startsWith("var("); hop++) {
    const ref = /^var\(--([a-z0-9-]+)\)$/.exec(v.trim());
    if (!ref) break;
    v = all.get(ref[1]!)?.value ?? v;
  }
  return v;
}

export const groups = {
  surfaces: pick(["color-bg", "color-bg2", "color-bg3", "color-bg4", "color-line", "color-line2"]),
  text: pick(["color-fg", "color-fg2", "color-fg3"]),
  brand: pick(["color-brand", "color-brand-hover", "color-select", "color-accent"]),
  semantic: pick(["color-ok", "color-warn", "color-err", "color-info"]),
  status: byPrefix("color-status-"),
  motion: [...byPrefix("hm-ease-"), ...byPrefix("hm-dur-")],
  tracking: byPrefix("hm-track-"),
};

export const source = SOURCE;
export const tokenCount = data.count;
