/**
 * Animated wallpaper layer — the live background that bleeds through the frosted
 * tiles when glass mode is on (Clonk's show-stealer). Code-generated scenes
 * (drifting multi-radial gradients), NOT art files: zero asset sourcing, GPU-cheap,
 * no WebGL context to lose on big boards.
 *
 * "Better for the canvas": ONE fixed full-bleed layer behind the react-flow pane
 * (not per-tile), so it never participates in the per-node re-raster during pan/
 * zoom. It pauses its animation on window blur / tab-hidden (Lively's trick) so an
 * idle, backgrounded app spends zero GPU on it, and honors prefers-reduced-motion
 * via styles.css. Only mounts when glass is on AND a scene is chosen — otherwise
 * the opaque pane would hide it and the animation would be wasted work.
 */
import { useEffect, useRef, useState } from "react";
import { useTheme } from "./theme-store";

/**
 * `embedded` renders the SAME scene as an absolute fill (position:absolute,
 * z-index:0) of its positioned parent instead of the default fixed full-window
 * layer — used by the terminal fit-to-screen overlay so the fullscreen terminal
 * sits over a clean copy of the live wallpaper (not the canvas + other tiles).
 */
export function Wallpaper({ embedded = false }: { embedded?: boolean } = {}): React.ReactElement | null {
  const { glass, wallpaper, videoSrc, imageSrc } = useTheme();
  const cls = embedded ? " embedded" : "";
  const [paused, setPaused] = useState(false);
  // A clip that can't decode (e.g. HEVC/H.265, which Chromium doesn't bundle)
  // fires <video> onError → we fall back to a gradient instead of a black void.
  const [videoFailed, setVideoFailed] = useState(false);
  useEffect(() => { setVideoFailed(false); }, [videoSrc]);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Pause the wallpaper (video decoder + bloom animations) when the window is
  // hidden/blurred OR the user has been idle for a while — a live wallpaper
  // composites every frame, so this reclaims continuous GPU + video-decode CPU
  // whenever you're not actively interacting. Resumes within ~1s of any input.
  // `bump` only writes a number (no React, no per-event timer churn); a 1Hz tick
  // computes the paused state, and setPaused no-ops when unchanged.
  useEffect(() => {
    let last = Date.now();
    const IDLE_MS = 30_000;
    const bump = () => { last = Date.now(); };
    const evs = ["mousemove", "keydown", "wheel", "pointerdown", "touchstart"] as const;
    for (const e of evs) window.addEventListener(e, bump, { passive: true });
    const tick = setInterval(() => {
      const idle = Date.now() - last > IDLE_MS;
      setPaused(document.hidden || !document.hasFocus() || idle);
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
    if (paused) v.pause();
    else void v.play().catch(() => {});
  }, [paused, videoSrc, wallpaper]);

  if (!glass || wallpaper === "none") return null;

  // Photo scene: a static image, cover-fit + brightness-controlled like the video.
  if (wallpaper === "image") {
    if (!imageSrc) return null; // no photo picked yet
    return (
      <div className={`hm-wallpaper${cls}`} data-scene="image" aria-hidden="true">
        <img className="hm-wp-image" src={imageSrc} alt="" />
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
            src={videoSrc}
            autoPlay
            loop
            muted
            playsInline
            onError={() => setVideoFailed(true)}
          />
          <div className="hm-wp-vignette" />
        </div>
      );
    }
    if (!videoSrc) return null; // no clip picked yet → nothing to show
    // videoSrc set but failed to decode → fall through to the gradient below.
  }

  // Gradient scenes (and the video-decode fallback → aurora).
  const scene = wallpaper === "video" ? "aurora" : wallpaper;
  return (
    <div className={`hm-wallpaper${cls}${paused ? " paused" : ""}`} data-scene={scene} aria-hidden="true">
      {/* Three drifting gradient blooms (screen-blended) → depth + slow color
          motion. A fine grain breaks up the gradient banding, a top sheen adds
          the "lit from above" glass feel, and a vignette focuses the center.
          Colors per scene come from CSS vars set by [data-scene] in styles.css. */}
      <div className="hm-wp-bloom hm-wp-a" />
      <div className="hm-wp-bloom hm-wp-b" />
      <div className="hm-wp-bloom hm-wp-c" />
      <div className="hm-wp-grain" />
      <div className="hm-wp-sheen" />
      <div className="hm-wp-vignette" />
    </div>
  );
}
