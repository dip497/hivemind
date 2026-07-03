/**
 * Custom-media layers — the user's OWN media, on two fixed full-window planes:
 *
 *  • BACKGROUND (rendered by Wallpaper.tsx via `MediaLayerView`) sits behind the
 *    canvas, over the animated wallpaper scene.
 *  • OVERLAY (this file's `CanvasOverlay`) sits ABOVE the tiles — and is ALWAYS
 *    `pointer-events:none`, so it decorates the canvas without ever intercepting
 *    a click, drag, or scroll.
 *
 * We ship NO art; both planes are empty until the user picks a file in the
 * Appearance drawer. `url: null` → render nothing (zero visual change).
 * Videos are always muted + loop + playsInline (autoplay requires muted).
 */
import { useEffect, useRef } from "react";
import { useTheme, type MediaLayer } from "./theme-store";

/** True when the user asked the OS to reduce motion. */
function usePrefersReducedMotion(): boolean {
  const ref = useRef(
    typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false,
  );
  return ref.current;
}

/**
 * Renders ONE user-supplied media layer as a fixed, full-window, non-interactive
 * plane at the given z-index. Shared by the background (in Wallpaper) and the
 * overlay (below). Nothing renders when `layer.url` is null.
 */
export function MediaLayerView({
  layer,
  z,
  scene,
}: {
  layer: MediaLayer;
  /** z-index of the plane (negative → behind the canvas; positive → over it). */
  z: number;
  /** data-attribute tag for debugging (e.g. "background" / "overlay"). */
  scene: string;
}): React.ReactElement | null {
  const reduceMotion = usePrefersReducedMotion();
  const videoRef = useRef<HTMLVideoElement>(null);

  // Honor prefers-reduced-motion: pause the clip so the layer is still shown
  // (a frozen frame) but adds no motion. Live otherwise.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (reduceMotion) v.pause();
    else void v.play().catch(() => {});
  }, [reduceMotion, layer.url]);

  if (!layer.url) return null;

  const base: React.CSSProperties = {
    position: "fixed",
    inset: 0,
    zIndex: z,
    opacity: layer.opacity,
    pointerEvents: "none",
  };
  const objectFit: "cover" | "contain" = layer.fit === "contain" ? "contain" : "cover";

  if (layer.kind === "video") {
    return (
      <video
        ref={videoRef}
        data-scene={scene}
        src={layer.url}
        // tiling isn't meaningful for <video> — fall back to cover.
        style={{ ...base, width: "100%", height: "100%", objectFit }}
        autoPlay={!reduceMotion}
        loop
        muted
        playsInline
        aria-hidden="true"
      />
    );
  }

  // Image — `tile` repeats via a CSS background; cover/contain via object-fit.
  if (layer.fit === "tile") {
    return (
      <div
        data-scene={scene}
        aria-hidden="true"
        style={{
          ...base,
          backgroundImage: `url("${layer.url}")`,
          backgroundRepeat: "repeat",
          backgroundSize: "auto",
        }}
      />
    );
  }
  return (
    <img
      data-scene={scene}
      src={layer.url}
      alt=""
      aria-hidden="true"
      style={{ ...base, width: "100%", height: "100%", objectFit }}
    />
  );
}

/**
 * The transparent foreground plane over the tiles. Mounted in Canvas. Always
 * pointer-events:none (via MediaLayerView) so it never blocks canvas interaction.
 * z-index sits above the react-flow pane; the tool-island Panels may float above
 * it, which is fine — it can't intercept input regardless.
 */
export function CanvasOverlay(): React.ReactElement | null {
  const { overlayMedia } = useTheme();
  return <MediaLayerView layer={overlayMedia} z={45} scene="overlay" />;
}
