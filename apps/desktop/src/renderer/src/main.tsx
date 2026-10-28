import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { Requests } from "./multiplayer/requests";
import { TooltipProvider } from "./components/ui/tooltip";
import { App } from "./App";
import { useThemeField } from "./theme-store";
// Self-host Geist (UI) and JetBrains Mono (terminal/code/IDs) so glyphs are available
// immediately and offline — no CDN round-trip, no flash-of-fallback that would
// leave xterm's glyph atlas built on the wrong metrics. Weights match --font-mono.
import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-sans/600.css";
import "@fontsource/geist-sans/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "@fontsource/jetbrains-mono/700.css";
// Code fonts to choose from in Appearance: a face is fetched only once it is drawn.
import "@fontsource/fira-code/400.css";
import "@fontsource/fira-code/500.css";
import "@fontsource/fira-code/600.css";
import "@fontsource/fira-code/700.css";
import "@fontsource/cascadia-code/400.css";
import "@fontsource/cascadia-code/500.css";
import "@fontsource/cascadia-code/600.css";
import "@fontsource/cascadia-code/700.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "@fontsource/geist-mono/600.css";
import "@fontsource/geist-mono/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "@fontsource/ibm-plex-mono/700.css";
import "./styles.css";

// A part loaded on first use (a dialog, a panel) that fails to load means the app was rebuilt or
// upgraded under this window: reload into the new build instead of going blank. Once a minute at
// most, so a part that is truly missing shows its error rather than reloading forever.
window.addEventListener("vite:preloadError", (e) => {
  const KEY = "hivemind:reloaded-for-new-build";
  let last = 0;
  try { last = Number(sessionStorage.getItem(KEY)) || 0; } catch { /* no storage: reload anyway */ }
  if (Date.now() - last < 60_000) return;
  try { sessionStorage.setItem(KEY, String(Date.now())); } catch { /* reload anyway */ }
  e.preventDefault();
  location.reload();
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5_000, refetchOnWindowFocus: false },
  },
});

// The faces the first screen is drawn with, loaded before its first layout: laid out while they
// load, its text is matched against the system's fonts down each font list, one wait on the browser
// for each family tried.
const FIRST_SCREEN_FACES = ['400 1em "Geist Sans"', '500 1em "Geist Sans"', '600 1em "Geist Sans"', '400 1em "JetBrains Mono"', '500 1em "JetBrains Mono"'];
await Promise.race([
  Promise.all(FIRST_SCREEN_FACES.map((face) => document.fonts.load(face).catch(() => []))),
  new Promise((resolve) => setTimeout(resolve, 500)),
]);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={200} skipDelayDuration={500}>
        <App />
        <Requests />
        <ThemedToaster />
      </TooltipProvider>
    </QueryClientProvider>
  </React.StrictMode>
);

/** Sonner's own chrome (close button, icons) in the theme's mode; the card colours are tokens. */
function ThemedToaster() {
  const mode = useThemeField("mode");
  return (
    <Toaster
      theme={mode}
      position="bottom-right"
      // One column with the agent cards (workspace/agent-toasts.tsx): these
      // stack above them, never over them, and stand left of a widget column
      // on the window's right edge with them, while the window has room.
      offset={{ bottom: "calc(12px + var(--agent-toasts-height, 0px))", right: "calc(12px + var(--toasts-right-inset))" }}
      // Solid, as the agent .hm-toast cards are (surface + token colors +
      // inner-top highlight), so action confirmations and agent events read
      // as one notification plane and keep their contrast over any view.
      toastOptions={{
        className: "hm-sonner",
        style: {
          background: "var(--surface-3)",
          color: "var(--color-fg)",
          border: "1px solid var(--color-line2)",
          borderRadius: "var(--radius-xl)",
          boxShadow: "var(--hm-highlight-glass), var(--hm-shadow-glass)",
          fontFamily: "var(--font-sans)",
          fontSize: "var(--text-label)",
        },
      }}
    />
  );
}
