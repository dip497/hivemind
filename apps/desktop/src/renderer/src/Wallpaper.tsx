/** Workspace decoration. Its media and CSS motion pause when covered by Settings. */
import { useEffect, useRef, useState } from "react";
import { isPluginWallpaper } from "@hivemind/core/settings-schema";
import { useTheme, wallpaperDrawn } from "./theme-store";
import { useWorkspaceOccluded } from "./workspace-occlusion";
import { LiveWallpaper } from "./live/LiveWallpaper";
import type { SceneAgent } from "./live/roster";
import { usableWallpaper, useWallpapers } from "./live/wallpaper-store";

const NO_AGENTS: readonly SceneAgent[] = [];
const NO_NAME = () => null;
const NO_OPEN = () => {};

/**
 * `embedded` renders the SAME scene as an absolute fill (position:absolute,
 * z-index:0) of its positioned parent instead of the default fixed full-window
 * layer — used by the terminal fit-to-screen overlay so the fullscreen terminal
 * sits over a clean copy of the live wallpaper (not the canvas + other tiles).
 * `agents` are the workspace's agents, for a live wallpaper that draws them. `live` is false
 * behind a plugin view, which paints its own scene: a live wallpaper shows the page colour there
 * and runs nothing. `nameOf` names an agent's tile for the label over its creature, and `onOpen` goes to it.
 */
export function Wallpaper({ embedded = false, covering = false, agents = NO_AGENTS, live = true, nameOf = NO_NAME, onOpen = NO_OPEN }: {
  embedded?: boolean; covering?: boolean; agents?: readonly SceneAgent[]; live?: boolean;
  nameOf?: (tileId: string) => string | null; onOpen?: (tileId: string) => void;
} = {}): React.ReactElement | null {
  const { glass, contentGlass, wallpaper, wallpaperColour, videoSrc, imageSrc, themeId, animate, palette, monoFont, mode } = useTheme();
  const { wallpapers } = useWallpapers();
  const cls = embedded ? " embedded" : "";
  // Away: the window is hidden or not focused. Idle: no input for a while, which pauses a video and
  // a photo's pan, but not a live wallpaper, which someone resting their hands is there to watch.
  const [away, setAway] = useState(false);
  const [idle, setIdle] = useState(false);
  const occluded = useWorkspaceOccluded();
  // `covering`: this copy is what covers the workspace, so occlusion is not about it.
  const hidden = away || (occluded && !covering);
  const paused = hidden || idle;
  // A clip that can't decode (e.g. HEVC/H.265, which Chromium doesn't bundle)
  // fires <video> onError → we fall back to a gradient instead of a black void.
  const [videoFailed, setVideoFailed] = useState(false);
  useEffect(() => { setVideoFailed(false); }, [videoSrc]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const reloadedRef = useRef(false);
  useEffect(() => { reloadedRef.current = false; }, [videoSrc]);
  // Re-arm after a successful playback: a source that has already played and errors again
  // is hitting a transient decode fault, not a bad file — worth reloading again.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const ok = () => { reloadedRef.current = false; };
    v.addEventListener("playing", ok);
    return () => v.removeEventListener("playing", ok);
  }, [videoSrc]);

  // Pause the wallpaper (video decoder + bloom animations) when the window is
  // hidden/blurred, and a video or photo pan also when the user has been idle for a
  // while: it composites every frame, so this reclaims continuous GPU + decode CPU.
  // Resumes within ~1s of any input. `bump` only writes a number (no React, no
  // per-event timer churn); a 1Hz tick computes the state, and each set no-ops
  // when unchanged.
  useEffect(() => {
    let last = Date.now();
    const IDLE_MS = 30_000;
    const bump = () => { last = Date.now(); };
    const evs = ["mousemove", "keydown", "wheel", "pointerdown", "touchstart"] as const;
    for (const e of evs) window.addEventListener(e, bump, { passive: true });
    const tick = setInterval(() => {
      setAway(document.hidden || !document.hasFocus());
      setIdle(Date.now() - last > IDLE_MS);
    }, 1000);
    return () => {
      clearInterval(tick);
      for (const e of evs) window.removeEventListener(e, bump);
    };
  }, []);

  // Stop the video decoder entirely when the window is backgrounded — zero GPU.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (paused) { v.pause(); return; }
    // Same lost-play race as CanvasOverlay: a rejected play() must retry while this
    // effect still wants playback, or the wallpaper stays frozen forever.
    let stale = false;
    const start = (): void => {
      if (stale) return;
      void v.play().catch((e: DOMException) => { if (e?.name === "AbortError") setTimeout(start, 250); });
    };
    start();
    return () => { stale = true; };
  }, [paused, videoSrc, wallpaper]);

  // The built-in animated/photo/video wallpaper scene (or null when glass is off and no theme set it,
  // no scene is chosen, or the picked media isn't ready). Computed as an element
  // so the user's OWN background media can render OVER it below without the early
  // returns swallowing it.
  const sceneEl: React.ReactElement | null = (() => {
    if (!wallpaperDrawn({ glass, wallpaper, themeId })) return null;

    // A package's live wallpaper, in its frame, on the page colour till it draws. One that is not
    // installed, whose package is off or that was turned off for misbehaving draws as Mono does.
    // Only the full-window copy behind the app's own views runs it; a copy behind a fullscreen tile
    // or a docked slot is covered by the tile, so it shows the page colour alone.
    const shared = { colour: wallpaperColour, agents, paused: hidden, animate, frosted: glass, seeThrough: contentGlass, page: palette.bg, text: palette.fg, attention: palette.warn, dark: mode !== "light", monoFont, nameOf, onOpen };
    const plugin = isPluginWallpaper(wallpaper) ? usableWallpaper(wallpapers, wallpaper) : null;
    if (plugin) {
      return (
        <div className={`hm-wallpaper${cls}`} data-scene="plugin" data-wallpaper={plugin.id} style={{ background: "var(--color-bg)" }} aria-hidden="true">
          {!embedded && live && <LiveWallpaper scene={plugin} {...shared} />}
        </div>
      );
    }

    // Photo scene: a static image, cover-fit + brightness-controlled like the video.
    if (wallpaper === "image") {
      if (!imageSrc) return null; // no photo picked yet
      return (
        <div className={`hm-wallpaper${cls}${paused ? " paused" : ""}`} data-scene="image" aria-hidden="true">
          <img className="hm-wp-image" src={window.hive.resourceUrl(imageSrc)} alt="" />
          <div className="hm-wp-vignette" />
        </div>
      );
    }

    // Video scene: a looping muted clip. Falls back to the aurora gradient if the
    // clip can't decode (HEVC/H.265 etc.) so it's never a black void.
    if (wallpaper === "video") {
      if (videoSrc && !videoFailed) {
        return (
          <div className={`hm-wallpaper${cls}${paused ? " paused" : ""}`} data-scene="video" aria-hidden="true">
            <video
              ref={videoRef}
              className="hm-wp-video"
              src={window.hive.resourceUrl(videoSrc)}
              autoPlay={!paused}
              loop
              muted
              playsInline
              onError={() => {
                // The first load can hit a transient decode error (PIPELINE_ERROR_DECODE on
                // a busy machine); one reload clears it. A second failure falls back to the
                // gradient below instead of retrying forever.
                const v = videoRef.current;
                if (v && !reloadedRef.current) { reloadedRef.current = true; v.load(); return; }
                setVideoFailed(true);
              }}
            />
            <div className="hm-wp-vignette" />
          </div>
        );
      }
      if (!videoSrc) return null; // no clip picked yet → nothing to show
      // videoSrc set but failed to decode → fall through to the gradient below.
    }

    // Gradient scenes (and the video-decode fallback → aurora; a package's wallpaper not to be had → mono).
    const scene = wallpaper === "video" ? "aurora" : isPluginWallpaper(wallpaper) ? "mono" : wallpaper;
    return (
      <div className={`hm-wallpaper${cls}${paused ? " paused" : ""}`} data-scene={scene} aria-hidden="true">
        {/* Three drifting gradient blooms → depth + slow color motion, then ONE
            static veil layer (vignette + top sheen + fine grain). Kept to four
            plain composited layers with no filters/masks/blend modes on purpose —
            see the PERF notes on .hm-wp-bloom / .hm-wp-veil in styles.css.
            Colors per scene come from CSS vars set by [data-scene] in styles.css. */}
        <div className="hm-wp-bloom hm-wp-a" />
        <div className="hm-wp-bloom hm-wp-b" />
        <div className="hm-wp-bloom hm-wp-c" />
        <div className="hm-wp-veil" />
      </div>
    );
  })();

  // User's OWN background media — a fixed full-window plane in the SAME z-band as
  // the wallpaper (behind the canvas), painted OVER the animated scene (later in
  // the DOM at the same z-index). Only for the default (non-embedded) layer; the
  // terminal fit-overlay wants a clean scene copy. Renders nothing when unset.
  return sceneEl;
}
