/**
 * Appearance controls — the ONE implementation of every theme control, used by
 * Settings ▸ Appearance. These are the controls the old ThemeCustomizer drawer
 * carried (presets, accent, background, glass, animation, overlays, terminal
 * palette); the drawer is gone and this is its replacement, so nothing is
 * maintained twice.
 *
 * All of it reads/writes the same store (`useTheme` / `setTheme` →
 * settings.json `appearance`), so a change repaints every surface live.
 *
 * Performance rules these follow: no live animated previews (a wallpaper
 * swatch is a static gradient, never a <video>), no polling, no timers, no new
 * dependencies. The expensive editors (terminal palette, per-overlay
 * placement) mount only when their disclosure is open.
 *
 * Layout uses the Settings shell's own classes (settings-section,
 * settings-row, settings-stack, …); the controls themselves are the shared
 * shadcn primitives (Button/Switch), which own their look and focus rings.
 */
import { useRef, useState } from "react";
import { Film, Image as ImageIcon, Plus, Trash, ChevronDown } from "./components/icons";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { Switch as SwitchPrimitive } from "./components/ui/switch";
import { GEIST_FONT, MONO_FONT, OLD_UI_FONT_DEFAULT, PRESETS, SYSTEM_MONO_FONT, UI_FONT, type TerminalPalette } from "@hivemind/core/settings-schema";
import { cssColorToHex } from "@hivemind/core/css-color";
import { accentOf } from "@hivemind/core/appearance-extra";
import { ACCENT_CONTRAST, accentMark, themeSwatches } from "@hivemind/core/theme-format";
import { useSettings } from "./settings-store";
import {
  ACCENTS, ANCHORS, CINEMATIC, WALLPAPERS, addOverlay, chooseAccent, chooseAccentColours, choosePreset, removeOverlay, setTheme, updateOverlay, wallpaperDrawn,
  type AccentId, type MediaAnchor, type MediaFit, type MediaLayer, type ThemeState, type WallpaperId,
} from "./theme-store";

// ── primitives ──────────────────────────────────────────────────────────────

export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <SwitchPrimitive checked={on} onCheckedChange={onChange} aria-label={label} />;
}

export function Slider({ label, value, min, max, suffix, onChange }: {
  label: string; value: number; min: number; max: number; suffix: string; onChange: (v: number) => void;
}) {
  return (
    <label className="settings-row settings-slider">
      <span>
        {label}
        <span className="settings-value">{value}{suffix}</span>
      </span>
      <input type="range" aria-label={label} className="hm-range" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

/** A settings section with its heading row. */
export function Section({ title, hint, action, children }: {
  title: string; hint?: string; action?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <section className="settings-section" aria-label={title}>
      <div className="settings-section-heading">
        <h3>{title}</h3>
        {action ?? (hint ? <span>{hint}</span> : null)}
      </div>
      {children}
    </section>
  );
}

// ── theme: presets + accent ─────────────────────────────────────────────────

/** Theme row: a native select plus a small static swatch strip showing what the
 *  chosen preset looks like, with the accent in use. The strip is five flat colours, chosen as a
 *  theme's are (`themeSwatches`) — no preview rendering, no motion.
 *
 *  SELECTOR NOTE: `data-preset-option` lives on each item of the list; the control
 *  itself carries `data-preset-select`. */
export function PresetRow({ t }: { t: ThemeState }) {
  // A look that is no built-in preset (imported, or a theme's) is shown as itself: as the theme
  // in use, or as "Custom".
  const preset = PRESETS[t.preset];
  const themeName = useSettings().appearanceExtra.theme?.name;
  const swatches = themeSwatches({ palette: (preset ?? t).palette, accent: t.accentCustom ?? t.accent });
  return (
    <div className="settings-row">
      <label htmlFor="theme-preset">Preset</label>
      <div className="settings-inline">
        <span className="settings-swatches" aria-hidden>
          {swatches.map((c, i) => (
            <span key={i} className="settings-swatch" style={{ background: c }} />
          ))}
        </span>
        <Select
          value={preset ? t.preset : "custom"}
          onValueChange={(v) => {
            const p = PRESETS[v];
            if (p) choosePreset(p);
          }}
        >
          <SelectTrigger id="theme-preset" data-preset-select className="min-w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            {!preset && <SelectItem value="custom" disabled>{themeName ?? "Custom"}</SelectItem>}
            {Object.values(PRESETS).map((p) => (
              <SelectItem key={p.id} value={p.id} data-preset-option={p.id}>{p.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

export function AccentPicker({ t }: { t: ThemeState }) {
  const custom = t.accentCustom;
  const wellRef = useRef<HTMLInputElement>(null);
  // A colour of the person's own is a mark too: say when it is hard to see where it is drawn, by the
  // rule a theme's accent is checked by.
  const mark = custom ? accentMark(custom.brand, t.palette) : null;
  return (
    <div className="settings-row">
      <div>
        <label id="accent-label">Accent</label>
        <p>The selected tile, sliders, links and the text cursor. A colour of your own, or a theme's, also fills the main button, a switch that is on and the focus ring.</p>
        {mark && mark.ratio < ACCENT_CONTRAST && <p className="settings-note" data-accent-faint>Hard to see on {mark.on === "bg" ? "this background" : "the panels"} ({mark.ratio.toFixed(1)}:1).</p>}
      </div>
      <div className="settings-accents" role="radiogroup" aria-labelledby="accent-label">
        {(Object.keys(ACCENTS) as AccentId[]).map((id) => {
          const a = ACCENTS[id];
          const sel = !custom && t.accent === id;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={sel}
              aria-label={a.label}
              title={a.label}
              onClick={() => chooseAccent(id)}
              className="settings-accent"
              data-selected={sel ? "" : undefined}
              style={{ background: a.swatch, ...(sel ? { boxShadow: `0 0 0 2px var(--color-bg2), 0 0 0 4px ${a.swatch}` } : {}) }}
            />
          );
        })}
        {/* Any colour: the native colour well, as Terminal colours use, opened from a swatch that
            takes focus like the others. */}
        <button
          type="button"
          className="settings-accent settings-accent-custom"
          role="radio"
          aria-checked={!!custom}
          aria-label="Your own colour"
          title="Your own colour"
          data-selected={custom ? "" : undefined}
          style={custom ? { background: custom.brand, boxShadow: `0 0 0 2px var(--color-bg2), 0 0 0 4px ${custom.brand}` } : undefined}
          onClick={() => wellRef.current?.showPicker?.() ?? wellRef.current?.click()}
        />
        <input
          ref={wellRef}
          type="color"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          data-accent-custom
          value={cssColorToHex(accentOf({ accent: t.accent }, { accent: custom }).brand, ACCENTS.graphite.brand)}
          onChange={(e) => chooseAccentColours({ brand: e.target.value, accent: e.target.value })}
        />
      </div>
    </div>
  );
}

// ── corners and fonts ───────────────────────────────────────────────────────

// The system font is the default (DESIGN.md); the font list most settings.json files hold reads as it.
const UI_FONTS = [{ id: "system", label: "System", value: UI_FONT, also: [OLD_UI_FONT_DEFAULT] }, { id: "geist", label: "Geist", value: GEIST_FONT }];
const MONO_FONTS = [{ id: "jetbrains", label: "JetBrains Mono", value: MONO_FONT }, { id: "system", label: "System", value: SYSTEM_MONO_FONT }];

/** A font: one of the faces named here, or any CSS font list the person types (Custom). */
function FontRow({ id, label, hint, value, fonts, onChange }: {
  id: string; label: string; hint: string; value: string;
  fonts: { id: string; label: string; value: string; also?: string[] }[]; onChange: (v: string) => void;
}) {
  const named = fonts.find((f) => f.value === value || f.also?.includes(value));
  const [chosen, setCustom] = useState(!named);
  // A font set elsewhere (a theme, `hive config set`) that is none of these is shown as Custom.
  const custom = chosen || !named;
  return (
    <div className="settings-row">
      <div><label htmlFor={id}>{label}</label><p>{hint}</p></div>
      <div className="settings-inline">
        {custom && (
          <Input
            className="min-w-48" aria-label={`${label}, custom`} defaultValue={value} key={value}
            onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== value) onChange(v); }}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          />
        )}
        <Select
          value={custom ? "custom" : named!.id}
          onValueChange={(v) => {
            const f = fonts.find((x) => x.id === v);
            setCustom(!f);
            if (f) onChange(f.value);
          }}
        >
          <SelectTrigger id={id} data-font-select={id} className="min-w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            {fonts.map((f) => <SelectItem key={f.id} value={f.id}>{f.label}</SelectItem>)}
            <SelectItem value="custom">Custom…</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

export function ShapeAndTypeControls({ t }: { t: ThemeState }) {
  return (
    <>
      <Slider label="Corners" value={t.radius} min={0} max={24} suffix="px" onChange={(v) => setTheme({ radius: v })} />
      <FontRow id="ui-font" label="Interface font" hint="Menus, panels and Settings." value={t.uiFont} fonts={UI_FONTS} onChange={(v) => setTheme({ uiFont: v })} />
      <FontRow id="mono-font" label="Code font" hint="Terminals, code and diffs." value={t.monoFont} fonts={MONO_FONTS} onChange={(v) => setTheme({ monoFont: v })} />
    </>
  );
}

// ── background ──────────────────────────────────────────────────────────────

/** Filename of a picked media URL, for the "currently using" line. */
function mediaName(src?: string): string | null {
  if (!src) return null;
  try { return decodeURIComponent(new URL(src).pathname.split("/").pop() || src); } catch { return src; }
}

export function BackgroundControls({ t }: { t: ThemeState }) {
  const src = t.wallpaper === "video" ? t.videoSrc : t.wallpaper === "image" ? t.imageSrc : undefined;
  const name = mediaName(src);
  // One picker for both kinds: main copies the file into its media dir and
  // returns a hivemedia:// URL, and what the user picked decides the kind.
  const pick = async () => {
    const r = await window.hive?.pickMedia?.("background");
    if (!r) return;
    if (r.kind === "video") setTheme({ wallpaper: "video", videoSrc: r.url });
    else setTheme({ wallpaper: "image", imageSrc: r.url });
  };
  const isMedia = t.wallpaper === "video" || t.wallpaper === "image";
  const current = WALLPAPERS.find((w) => w.id === t.wallpaper)?.label ?? "None";
  return (
    <>
      {/* The picker is a disclosure: eleven scenes are a rare choice, and an
          always-open grid pushed every other setting off the page. */}
      <details className="settings-disclosure">
        <summary>Background<span className="settings-summary-value">{current}</span><ChevronDown size={14} /></summary>
        <div className="settings-wallpapers" role="radiogroup" aria-label="Background" >
          {WALLPAPERS.map((w) => {
            const sel = t.wallpaper === w.id;
            const onClick = w.id === "video" || w.id === "image"
              ? () => { setTheme({ wallpaper: w.id }); if (!(w.id === "video" ? t.videoSrc : t.imageSrc)) void pick(); }
              : () => setTheme({ wallpaper: w.id });
            return (
              <button key={w.id} type="button" className="settings-wallpaper" role="radio" aria-checked={sel} aria-label={w.label} data-wallpaper-option={w.id} onClick={onClick}>
                <span className="settings-wallpaper-preview" aria-hidden data-scene={w.id}>
                  {w.id === "video" && <Film size={13} />}
                  {w.id === "image" && <ImageIcon size={13} />}
                </span>
                <span className="settings-wallpaper-name">{w.label}</span>
              </button>
            );
          })}
        </div>
      </details>

      {isMedia && (
        <div className="settings-row">
          <div>
            <label>{t.wallpaper === "video" ? "Video file" : "Photo file"}</label>
            <p className="settings-path">{name ?? "No file chosen yet."}</p>
          </div>
          <div className="settings-inline">
            <Button variant="outline" onClick={() => void pick()}>{name ? "Change…" : "Choose file…"}</Button>
            <Button variant="outline" title="Dim the media and thicken the panel tint so text stays readable" onClick={() => setTheme(CINEMATIC)}>Cinematic</Button>
          </div>
        </div>
      )}
      {isMedia && (
        <Slider label="Media brightness" value={Math.round((t.videoBrightness ?? 0.85) * 100)} min={40} max={110} suffix="%" onChange={(v) => setTheme({ videoBrightness: v / 100 })} />
      )}

      <div className="settings-row">
        <div><label>Animation</label><p>Drifting scenes and slow photo pans. Pauses when the window loses focus.</p></div>
        <Switch on={t.animate} onChange={(v) => setTheme({ animate: v })} label="Animate the background" />
      </div>
      {t.wallpaper !== "none" && !wallpaperDrawn(t) && (
        <p className="settings-note">The background shows behind your tools when glass is on.</p>
      )}
    </>
  );
}

// ── glass ───────────────────────────────────────────────────────────────────

export function GlassControls({ t }: { t: ThemeState }) {
  return (
    <>
      <div className="settings-row">
        <div><label>Glass</label><p>Frosted panels over the background.</p></div>
        <Switch on={t.glass} onChange={(v) => setTheme({ glass: v })} label="Glass panels" />
      </div>
      {/* Conditional: the tint/blur numbers mean nothing with glass off. */}
      {t.glass && (
        <>
          <Slider label="Panel opacity" value={Math.round(t.opacity * 100)} min={30} max={95} suffix="%" onChange={(v) => setTheme({ opacity: v / 100 })} />
          <Slider label="Blur" value={t.blur} min={8} max={24} suffix="px" onChange={(v) => setTheme({ blur: v })} />
          <div className="settings-row">
            <div><label>Frost tool content</label><p>The background also shows through terminals and editors.</p></div>
            <Switch on={t.contentGlass} onChange={(v) => setTheme({ contentGlass: v })} label="Frost tool content" />
          </div>
          {t.contentGlass && (
            <Slider label="Content tint" value={Math.round(t.contentOpacity * 100)} min={0} max={90} suffix="%" onChange={(v) => setTheme({ contentOpacity: v / 100 })} />
          )}
        </>
      )}
    </>
  );
}

// ── overlays ────────────────────────────────────────────────────────────────

function newOverlayId(): string {
  try { if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID(); } catch { /* fall through */ }
  return `ov-${Math.random().toString(36).slice(2, 10)}`;
}

const FITS: { id: MediaFit; label: string }[] = [
  { id: "cover", label: "Cover" }, { id: "contain", label: "Contain" }, { id: "tile", label: "Tile" },
];

/** One overlay: file, opacity, fit — with size + placement behind a disclosure
 *  so the 3×3 anchor grid mounts only when it is opened. */
function OverlayRow({ layer, index }: { layer: MediaLayer; index: number }) {
  const [placement, setPlacement] = useState(false);
  const size = layer.size ?? 1;
  const full = size >= 0.999;
  return (
    <div className="settings-extension" data-overlay={layer.id}>
      <div className="settings-extension-row">
        <div className="settings-extension-icon">{layer.kind === "video" ? <Film size={17} /> : <ImageIcon size={17} />}</div>
        <div className="settings-extension-label">
          <h4>{layer.name ?? `Overlay ${index + 1}`}</h4>
          <p>{Math.round(layer.opacity * 100)}% opacity<span>·</span>{FITS.find((f) => f.id === layer.fit)?.label ?? "Cover"}</p>
        </div>
        <Button
          variant="destructive"
          size="icon"
          aria-label={`Remove overlay ${index + 1}`}
          onClick={() => removeOverlay(layer.id)}
        >
          <Trash />
        </Button>
      </div>
      <Slider label="Opacity" value={Math.round(layer.opacity * 100)} min={0} max={100} suffix="%" onChange={(v) => updateOverlay(layer.id, { opacity: v / 100 })} />
      <div className="settings-row">
        <div><label>Fit</label></div>
        <div className="settings-inline" role="radiogroup" aria-label={`Overlay ${index + 1} fit`}>
          {FITS.map((f) => (
            <Button key={f.id} role="radio" aria-checked={layer.fit === f.id} variant={layer.fit === f.id ? "secondary" : "outline"} data-selected={layer.fit === f.id ? "" : undefined} onClick={() => updateOverlay(layer.id, { fit: f.id })}>
              {f.label}
            </Button>
          ))}
        </div>
      </div>
      <details className="settings-disclosure" onToggle={(e) => setPlacement((e.currentTarget as HTMLDetailsElement).open)}>
        <summary>Size and placement<ChevronDown size={14} /></summary>
        {placement && (
          <>
            <Slider label="Size" value={full ? 100 : Math.round(size * 100)} min={15} max={100} suffix={full ? "% (full)" : "%"} onChange={(v) => updateOverlay(layer.id, { size: v / 100 })} />
            <div className="settings-anchors" role="radiogroup" aria-label={`Overlay ${index + 1} position`} data-disabled={full ? "" : undefined}>
              {ANCHORS.map((a) => {
                const sel = !full && (layer.anchor ?? "center") === a;
                return (
                  <button
                    key={a}
                    type="button"
                    role="radio"
                    aria-checked={sel}
                    aria-label={a.replace(/-/g, " ")}
                    onClick={() => updateOverlay(layer.id, { anchor: a as MediaAnchor })}
                    disabled={full}
                    className="settings-anchor"
                    data-selected={sel ? "" : undefined}
                  >
                    <span />
                  </button>
                );
              })}
            </div>
          </>
        )}
      </details>
    </div>
  );
}

export function OverlayControls({ t }: { t: ThemeState }) {
  const add = async () => {
    // The slot id is minted first so the copied file and the layer agree —
    // main prunes per slot by that prefix.
    const id = newOverlayId();
    const r = await window.hive?.pickMedia?.(`overlay:${id}`);
    if (r) addOverlay({ id, url: r.url, kind: r.kind, name: r.name });
  };
  const n = t.overlayMedia.length;
  return (
    <details className="settings-disclosure">
      <summary>Overlays<span className="settings-summary-value">{n === 0 ? "None" : `${n}`}</span><ChevronDown size={14} /></summary>
      {n === 0 && (
        <p className="settings-note">
          Place images or videos over the workspace. Supports transparent WebM, GIF and PNG files.
        </p>
      )}
      <div className="settings-extension-list">
        {t.overlayMedia.map((layer, i) => <OverlayRow key={layer.id} layer={layer} index={i} />)}
      </div>
      <Button variant="link" className="mt-3" onClick={() => void add()}><Plus />Add overlay</Button>
    </details>
  );
}

// ── advanced: terminal colours ──────────────────────────────────────────────

/** The non-ANSI terminal colours, derived rather than spelled out (one of them
 *  shares a name with an agent provider and the catalog guard rejects it). */
type TermSpecial = Exclude<keyof TerminalPalette, "ansi" | "selection">;
const termSpecial = (t: TerminalPalette) =>
  (Object.keys(t) as (keyof TerminalPalette)[]).filter((k): k is TermSpecial => k !== "ansi" && k !== "selection");

const ANSI_NAMES = ["Black", "Red", "Green", "Yellow", "Blue", "Magenta", "Cyan", "White"];
const ansiLabel = (i: number) => `${i > 7 ? "Bright " : ""}${ANSI_NAMES[i % 8]}`;

/** 4 + 16 colour wells. Mounted only when its disclosure is open. */
export function TerminalColors({ t }: { t: ThemeState }) {
  const setTerm = (patch: Partial<TerminalPalette>) => setTheme({ terminal: { ...t.terminal, ...patch } });
  const preset = PRESETS[t.preset] ?? PRESETS.signal!;
  const dirty = JSON.stringify(t.terminal) !== JSON.stringify(preset.terminal);
  return (
    <>
      <div className="settings-row">
        <div><label>Base colours</label><p>Background, text and the cursor in every terminal.</p></div>
        <div className="settings-inline">
          {termSpecial(t.terminal).map((k) => (
            <label key={k} className="settings-color-label">
              <input className="settings-color" type="color" aria-label={k} value={t.terminal[k]} onChange={(e) => setTerm({ [k]: e.target.value } as Partial<TerminalPalette>)} />
              {k}
            </label>
          ))}
        </div>
      </div>
      <div className="settings-colors settings-ansi" data-term-ansi>
        {t.terminal.ansi.map((c, i) => (
          <label key={i} className="settings-color-label">
            <input className="settings-color" type="color" aria-label={ansiLabel(i)} value={c} onChange={(e) => setTerm({ ansi: t.terminal.ansi.map((x, j) => (j === i ? e.target.value : x)) })} />
            {ansiLabel(i)}
          </label>
        ))}
      </div>
      <div className="settings-actions">
        <Button variant="outline" disabled={!dirty} onClick={() => setTerm({ ...preset.terminal, ansi: [...preset.terminal.ansi] })}>
          Reset to {preset.label}
        </Button>
      </div>
    </>
  );
}
