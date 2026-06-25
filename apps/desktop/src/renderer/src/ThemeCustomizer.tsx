/**
 * Appearance customizer — Clonk's first-class personalization panel. A frosted
 * slide-in drawer that drives the global theme-store: glass on/off, panel
 * opacity + blur sliders, accent palette (Volt/Ember/Ice/Pulse), and the live
 * wallpaper picker. Pure presentational — all state lives in theme-store, so
 * every surface in the app repaints live as you drag.
 */
import { useRef } from "react";
import { X, Film, Image as ImageIcon } from "lucide-react";
import {
  useTheme,
  setTheme,
  ACCENTS,
  WALLPAPERS,
  type AccentId,
  type WallpaperId,
} from "./theme-store";

/** Mini scene previews for the wallpaper grid — mirror the styles.css palettes. */
const WP_PREVIEW: Record<WallpaperId, string> = {
  none: "var(--color-bg4)",
  aurora:
    "radial-gradient(circle at 28% 30%, #4f46e5, transparent 58%), radial-gradient(circle at 74% 72%, #14b8a6, transparent 58%), #0a0d18",
  ember:
    "radial-gradient(circle at 28% 30%, #f97316, transparent 58%), radial-gradient(circle at 74% 72%, #db2777, transparent 58%), #140a08",
  ice: "radial-gradient(circle at 28% 30%, #0ea5e9, transparent 58%), radial-gradient(circle at 74% 72%, #22d3ee, transparent 58%), #06121a",
  mesh: "radial-gradient(circle at 28% 30%, #8b5cf6, transparent 58%), radial-gradient(circle at 74% 72%, #ec4899, transparent 58%), #0b0a14",
  sunset: "radial-gradient(circle at 28% 30%, #f97316, transparent 58%), radial-gradient(circle at 74% 72%, #ef4444, transparent 58%), #160a0c",
  forest: "radial-gradient(circle at 28% 30%, #10b981, transparent 58%), radial-gradient(circle at 74% 72%, #84cc16, transparent 58%), #07140d",
  nebula: "radial-gradient(circle at 28% 30%, #a855f7, transparent 58%), radial-gradient(circle at 74% 72%, #6366f1, transparent 58%), #0a0816",
  mono: "radial-gradient(circle at 28% 30%, #64748b, transparent 58%), radial-gradient(circle at 74% 72%, #475569, transparent 58%), #0b0d12",
  image: "linear-gradient(135deg, #334155, #0f172a)",
  video: "linear-gradient(135deg, #1e293b, #0b1120)",
};

/** Extract a display name + path from a wallpaper media URL. */
function mediaInfo(src?: string): { name: string; path: string } | null {
  if (!src) return null;
  if (src.startsWith("hm-media://")) {
    try {
      const p = decodeURIComponent(new URL(src).pathname.replace(/^\/+/, ""));
      return { name: p.split("/").pop() || p, path: p };
    } catch {
      return null;
    }
  }
  if (src.startsWith("blob:")) return { name: "Unsaved file", path: "Not saved — re-pick after restart" };
  return { name: src, path: src };
}

export function ThemeCustomizer({ open, onClose }: { open: boolean; onClose: () => void }): React.ReactElement | null {
  const t = useTheme();
  const fileRef = useRef<HTMLInputElement>(null);
  const pendingKind = useRef<"video" | "image">("video");

  function pickMedia(kind: "video" | "image") {
    pendingKind.current = kind;
    if (!fileRef.current) return;
    fileRef.current.accept = kind === "video" ? "video/mp4,video/webm,video/*" : "image/*";
    fileRef.current.click();
  }
  async function onMediaFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file later
    if (!f) return;
    // Copy the picked file into main's sandboxed wallpaper dir and use the
    // returned hm-media:// URL — PERSISTENT (survives reload/restart) and safe
    // (main only ever serves files confined to that dir). Fall back to an
    // in-memory blob: URL only if import fails (non-Electron / unreadable).
    const p = window.hive?.getPathForFile?.(f);
    let src: string | null = null;
    if (p) src = (await window.hive?.importWallpaper?.(p)) ?? null;
    if (!src) src = URL.createObjectURL(f);
    if (pendingKind.current === "video") setTheme({ wallpaper: "video", videoSrc: src });
    else setTheme({ wallpaper: "image", imageSrc: src });
  }

  if (!open) return null;
  const activeMedia = t.wallpaper === "video" ? mediaInfo(t.videoSrc) : t.wallpaper === "image" ? mediaInfo(t.imageSrc) : null;
  return (
    <div
      className="hm-drawer-in fixed right-3 top-3 bottom-3 z-50 w-[296px] hm-island rounded-2xl p-4 flex flex-col gap-5 overflow-y-auto pointer-events-auto"
      role="dialog"
      aria-label="Appearance settings"
    >
      <header className="flex items-center justify-between">
        <h2 className="text-[13px] font-semibold text-[var(--color-fg)]">Appearance</h2>
        <button
          onClick={onClose}
          aria-label="close appearance"
          className="size-6 grid place-items-center rounded text-[var(--color-fg3)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg4)] cursor-pointer"
        >
          <X size={14} />
        </button>
      </header>

      {/* Master glass toggle */}
      <Row label="Glass mode" hint="Frosted panels over a live wallpaper">
        <Switch on={t.glass} onChange={(v) => setTheme({ glass: v })} />
      </Row>

      {/* Opacity + blur — only meaningful with glass on */}
      <div className={t.glass ? "" : "opacity-40 pointer-events-none"}>
        <Slider
          label="Panel opacity"
          value={Math.round(t.opacity * 100)}
          min={30}
          max={95}
          suffix="%"
          onChange={(v) => setTheme({ opacity: v / 100 })}
        />
        <Slider
          label="Blur"
          value={t.blur}
          min={8}
          max={24}
          suffix="px"
          onChange={(v) => setTheme({ blur: v })}
        />
        <Row label="Frost tile content" hint="Wallpaper bleeds through terminals + editors">
          <Switch on={t.contentGlass} onChange={(v) => setTheme({ contentGlass: v })} />
        </Row>
        {t.contentGlass && (
          <Slider
            label="Content tint"
            value={Math.round(t.contentOpacity * 100)}
            min={0}
            max={90}
            suffix="%"
            onChange={(v) => setTheme({ contentOpacity: v / 100 })}
          />
        )}
      </div>

      {/* Accent palette */}
      <div className="flex flex-col gap-2">
        <span className="u-eyebrow">Accent</span>
        <div className="flex flex-wrap items-center gap-2.5">
          {(Object.keys(ACCENTS) as AccentId[]).map((id) => {
            const a = ACCENTS[id];
            const sel = t.accent === id;
            return (
              <button
                key={id}
                onClick={() => setTheme({ accent: id })}
                title={a.label}
                aria-label={a.label}
                aria-pressed={sel}
                className="size-7 rounded-full cursor-pointer transition-transform hover:scale-110"
                style={{
                  background: a.swatch,
                  boxShadow: sel ? `0 0 0 2px var(--color-bg2), 0 0 0 4px ${a.swatch}` : "none",
                }}
              />
            );
          })}
        </div>
      </div>

      {/* Wallpaper picker */}
      <div className="flex flex-col gap-2">
        <span className="u-eyebrow">Wallpaper</span>
        <div className="grid grid-cols-3 gap-2">
          {WALLPAPERS.map((w) => {
            const sel = t.wallpaper === w.id;
            // Video/Photo tiles open a file picker if nothing is chosen yet.
            const onClick = w.id === "video"
              ? () => { setTheme({ wallpaper: "video" }); if (!t.videoSrc) pickMedia("video"); }
              : w.id === "image"
              ? () => { setTheme({ wallpaper: "image" }); if (!t.imageSrc) pickMedia("image"); }
              : () => setTheme({ wallpaper: w.id });
            return (
              <button
                key={w.id}
                onClick={onClick}
                title={w.label}
                aria-pressed={sel}
                className="group flex flex-col items-center gap-1 cursor-pointer"
              >
                <span
                  className="h-12 w-full rounded-lg border transition-all grid place-items-center text-[var(--color-fg3)]"
                  style={{
                    background: WP_PREVIEW[w.id],
                    borderColor: sel ? "var(--color-brand)" : "var(--color-line2)",
                    boxShadow: sel ? "0 0 0 1px var(--color-brand)" : "none",
                  }}
                >
                  {w.id === "video" && <Film size={16} />}
                  {w.id === "image" && <ImageIcon size={16} />}
                </span>
                <span className={`text-[10px] ${sel ? "text-[var(--color-fg)]" : "text-[var(--color-fg3)] group-hover:text-[var(--color-fg2)]"}`}>
                  {w.label}
                </span>
              </button>
            );
          })}
        </div>
        <Row label="Animate" hint="Drifting scenes · Ken-Burns photos">
          <Switch on={t.animate} onChange={(v) => setTheme({ animate: v })} />
        </Row>
        {(t.wallpaper === "video" || t.wallpaper === "image") && (
          <div className="flex flex-col gap-2">
            <button
              onClick={() => pickMedia(t.wallpaper === "video" ? "video" : "image")}
              className="self-start text-[11px] px-2 py-1 rounded border border-[var(--color-line2)] text-[var(--color-fg2)] hover:bg-[var(--color-bg4)] hover:text-[var(--color-fg)] cursor-pointer"
            >
              {activeMedia
                ? t.wallpaper === "video" ? "Change video…" : "Change photo…"
                : t.wallpaper === "video" ? "Choose video file…" : "Choose photo…"}
            </button>
            {activeMedia && (
              <div className="rounded-md border border-[var(--color-line2)] bg-[var(--color-bg3)] px-2 py-1.5 min-w-0">
                <div className="text-[11px] text-[var(--color-fg)] truncate" title={activeMedia.name}>{activeMedia.name}</div>
                <div className="text-[10px] font-mono text-[var(--color-fg3)] truncate" title={activeMedia.path}>{activeMedia.path}</div>
              </div>
            )}
            <Slider
              label="Brightness"
              value={Math.round((t.videoBrightness ?? 0.85) * 100)}
              min={40}
              max={110}
              suffix="%"
              onChange={(v) => setTheme({ videoBrightness: v / 100 })}
            />
          </div>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="video/mp4,video/webm,video/*"
          className="hidden"
          onChange={onMediaFile}
        />
        <p className="text-[10px] leading-snug text-[var(--color-fg3)]">
          Wallpaper shows behind the canvas when Glass mode is on. It pauses when the window loses focus.
        </p>
      </div>
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex flex-col">
        <span className="text-[12px] text-[var(--color-fg)]">{label}</span>
        {hint && <span className="text-[10px] text-[var(--color-fg3)]">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  // Flex-anchored knob (no absolute positioning) so it can never escape the
  // track: 36px track − 4px padding − 16px knob = 16px of travel.
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={`inline-flex h-5 w-9 shrink-0 items-center rounded-full px-0.5 transition-colors cursor-pointer ${on ? "bg-[var(--color-brand)]" : "bg-[var(--color-bg4)]"}`}
    >
      <span
        className="size-4 rounded-full bg-white shadow-sm transition-transform"
        style={{ transform: on ? "translateX(16px)" : "translateX(0)" }}
      />
    </button>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  suffix: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5 py-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[12px] text-[var(--color-fg2)]">{label}</span>
        <span className="text-[11px] font-mono tabular-nums text-[var(--color-fg3)]">
          {value}
          {suffix}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="hm-range w-full cursor-pointer"
      />
    </label>
  );
}
