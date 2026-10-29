/** A live wallpaper: a scene behind the canvas (Shoal's sea, Koi Pond's pond, a package's own …) in
 *  its own colours, whose life goes on by itself and plays with the pointer over empty canvas. It
 *  is told nothing of the workspace; the tiles sit on top of it. */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { cssColorToHex } from "../workspace/css-color";
import { LiveEngine, type SceneId } from "./engine";
import type { SceneEngine } from "./page-scene";
import { PluginEngine, type PluginWallpaper } from "./plugin-engine";
import type { SceneMode } from "./scene";
import { turnWallpaperOff } from "./wallpaper-store";

/** A media query as a store, for useSyncExternalStore. */
function mediaStore(query: string) {
  const mq = typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query) : null;
  return {
    watch: (cb: () => void) => {
      mq?.addEventListener("change", cb);
      return () => mq?.removeEventListener("change", cb);
    },
    now: () => mq?.matches === true,
  };
}
const lessMotion = mediaStore("(prefers-reduced-motion: reduce)");
// The wallpaper layer is not shown at all for these (styles.css): nothing to draw.
const moreContrast = mediaStore("(prefers-contrast: more)");
const lessTransparency = mediaStore("(prefers-reduced-transparency: reduce)");

export function LiveWallpaper({ scene, paused, animate, page, text, dark, monoFont }: {
  /** One of the app's scenes, or a package's live wallpaper. */
  scene: SceneId | PluginWallpaper;
  /** The window is hidden or unfocused, or something covers the workspace. */
  paused: boolean;
  /** The person's Animation switch. */
  animate: boolean;
  /** The theme's page and text colours (CSS), and whether it is dark. */
  page: string;
  text: string;
  dark: boolean;
  /** The terminal's font, which the scene's characters take (read from the page; this says when). */
  monoFont: string;
}): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const [engine, setEngine] = useState<SceneEngine | null>(null);
  const sceneKey = typeof scene === "string" ? scene : `${scene.id} ${scene.url}`;
  const reduced = useSyncExternalStore(lessMotion.watch, lessMotion.now, lessMotion.now);
  const contrast = useSyncExternalStore(moreContrast.watch, moreContrast.now, moreContrast.now);
  const solid = useSyncExternalStore(lessTransparency.watch, lessTransparency.now, lessTransparency.now);
  const shown = !contrast && !solid;
  const mode: SceneMode = !animate || reduced ? "still" : paused ? "hold" : "run";

  // The colours it is drawn by now: a package's page is told them first, with everything else.
  const look = { page: cssColorToHex(page), text: cssColorToHex(text), dark, mono: monoFont };
  const lookRef = useRef(look);
  lookRef.current = look;

  // A scene of its own for each: a canvas is handed to one worker only once, and a package's page
  // gets a frame of its own.
  useEffect(() => {
    if (!shown) return;
    const events = {
      disable: (reason: string) => {
        if (typeof scene === "string") return;
        turnWallpaperOff(scene.id, reason);
        toast.error(`The ${scene.name} live wallpaper was turned off: ${reason}. The plain background shows until Hivemind starts again.`);
      },
    };
    const e = typeof scene === "string" ? new LiveEngine(hostRef.current!, scene, events) : new PluginEngine(hostRef.current!, scene, lookRef.current, events);
    setEngine(e);
    return () => { e.destroy(); setEngine(null); };
    // `scene` is the same scene while its key is.
  }, [shown, sceneKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { engine?.setLook(lookRef.current); }, [engine, page, text, dark, monoFont]);
  useEffect(() => { engine?.fontChanged(); }, [engine, monoFont]);
  useEffect(() => { engine?.setMode(mode); }, [engine, mode]);

  return <div ref={hostRef} className="hm-live" />;
}
