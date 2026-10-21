/**
 * The look a plugin reads and adds to. The app's tokens (`APP_TOKENS`) are the theme every plugin
 * is painted with, as CSS custom properties (`applyThemeVars`). A plugin may declare tokens of its
 * own (a view's `tokens` in hivemind-view.json): each a colour with a default for dark and for
 * light, written as `#rrggbb` or as one of the app's colours (`=accent`), so that by default it
 * follows the theme. The person can set any of them (Settings, `hive plugins set`): each is one of
 * the plugin's settings, a `color` field named `token-<id>`. The app resolves them and sends them
 * with the theme; the plugin reads `var(--hm-token-<id>)`. Pure: the app, the CLI and a plugin's
 * own build share it. Design: docs/design/customization-2026-10-21.md.
 */
import type { SettingField } from "./settings.js";

/** The version of the token contract: raised when a token is renamed or removed, never when one
 *  is added. */
export const TOKENS_VERSION = 1;

/** The app's colours a plugin is sent (`theme.colors`), each as `--hm-color-<name>`, and what each is for. */
export const APP_COLORS = {
  bg: "the window's background", bg2: "a panel or card", bg3: "a control or a raised panel", bg4: "a pressed control",
  fg: "text", fg2: "secondary text", fg3: "faint text, placeholders",
  line: "a hairline border", line2: "a stronger border",
  brand: "the app's mark and its working colour", accent: "the person's accent, for what is selected or primary",
  err: "an error", ok: "success", warn: "a warning", info: "information",
} as const;
export type AppColor = keyof typeof APP_COLORS;

/** Every other token the app sets on a plugin's document, and what each is. */
export const APP_TOKENS = {
  ...Object.fromEntries(Object.entries(APP_COLORS).map(([k, v]) => [`--hm-color-${k}`, v])),
  "--hm-status-working": "an agent working", "--hm-status-attention": "an agent waiting on the person",
  "--hm-status-done": "an agent's finished turn", "--hm-status-idle": "an agent at rest",
  "--hm-status-exited": "an agent that has closed", "--hm-status-failed": "an agent that failed",
  "--hm-accent": "the person's accent colour", "--hm-radius": "the corner radius, in px",
  "--hm-font-ui": "the interface font", "--hm-font-mono": "the monospace font",
  "--hm-surface": "the panel surface colour", "--hm-terminal-bg": "a terminal's background",
  "--hm-glass": "1 when glass is on, 0 when not", "--hm-mode": "dark or light",
} as Record<string, string>;

/** A token a plugin declares: a colour of its own, with a default in each mode. */
export interface TokenDecl {
  id: string;
  label: string;
  description?: string;
  /** `#rrggbb`, or `=<app colour>` to be that colour of the theme. */
  dark: string;
  light: string;
}

const TOKEN_ID = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_TOKENS = 24;
const HEX = /^#[0-9a-f]{6}$/;
/** The setting a token's colour is kept in: one of the plugin's own, so it is set like any other. */
export const TOKEN_FIELD_PREFIX = "token-";
export const tokenField = (id: string): string => `${TOKEN_FIELD_PREFIX}${id}`;
/** The CSS custom property a token is set as on the plugin's document. */
export const tokenVar = (id: string): string => `--hm-token-${id}`;

const valueOk = (v: unknown): v is string => typeof v === "string" && (HEX.test(v.toLowerCase()) || (v.startsWith("=") && v.slice(1) in APP_COLORS));

/** The tokens a manifest declares, each checked, and the position of each one left out (a bad id,
 *  a repeated one, a default that is neither `#rrggbb` nor `=<app colour>`, past 24). */
export function checkTokenDecls(raw: unknown): { tokens: TokenDecl[]; refused: number[] } {
  const tokens: TokenDecl[] = [];
  const refused: number[] = [];
  if (!Array.isArray(raw)) return { tokens, refused };
  const seen = new Set<string>();
  raw.forEach((r: unknown, i) => {
    const o = r && typeof r === "object" && !Array.isArray(r) ? (r as Record<string, unknown>) : null;
    if (!o || i >= MAX_TOKENS || typeof o.id !== "string" || !TOKEN_ID.test(o.id) || seen.has(o.id) || !valueOk(o.dark) || !valueOk(o.light)) { refused.push(i); return; }
    seen.add(o.id);
    const label = typeof o.label === "string" && o.label.trim() ? o.label.trim().slice(0, 80) : o.id;
    const description = typeof o.description === "string" && o.description.trim() ? o.description.trim().slice(0, 300) : undefined;
    tokens.push({ id: o.id, label, ...(description ? { description } : {}), dark: (o.dark as string).toLowerCase(), light: (o.light as string).toLowerCase() });
  });
  return { tokens, refused };
}

/** The settings a plugin's tokens add: a colour each, "as the theme has it" until the person sets one. */
export function tokenFields(tokens: readonly TokenDecl[]): SettingField[] {
  return tokens.map((t) => ({ id: tokenField(t.id), label: t.label, ...(t.description ? { description: t.description } : {}), section: "Colours", type: "color" as const, default: "" }));
}

/** Each token's colour now: the person's, when they set one; else its default for `mode`, an app
 *  colour taken from `colors` (the theme's, resolved to hex). */
export function resolveTokens(tokens: readonly TokenDecl[], mode: "dark" | "light" | undefined, colors: Readonly<Record<string, string>>, settings: Readonly<Record<string, unknown>> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of tokens) {
    const set = settings?.[tokenField(t.id)];
    if (typeof set === "string" && HEX.test(set)) { out[t.id] = set; continue; }
    const d = mode === "light" ? t.light : t.dark;
    const v = d.startsWith("=") ? colors[d.slice(1)] : d;
    if (v) out[t.id] = v;
  }
  return out;
}
