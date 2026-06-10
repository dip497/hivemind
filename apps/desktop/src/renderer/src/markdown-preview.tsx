import { useEffect, useRef } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

/**
 * Lightweight markdown viewer for the editor's Preview mode.
 *
 * Footprint by design:
 *   - `marked` (~12kB gz) turns markdown → an HTML string. Far lighter than the
 *     react-markdown / remark / rehype / unified stack (many packages, more
 *     runtime memory) — for a read-only viewer the string path is the lean one.
 *   - `DOMPurify` sanitizes that HTML so raw inline HTML in the doc renders
 *     SAFELY (scripts / event handlers / javascript: URLs are stripped). This is
 *     what lets us honor "HTML stuff" without opening an XSS hole.
 *   - `mermaid` is the only heavy piece, so it's DYNAMICALLY imported — loaded
 *     once, the first time a doc actually contains a ```mermaid block, and never
 *     for plain markdown. Vite code-splits it into its own async chunk, so the
 *     base bundle stays small.
 *
 * Code blocks render as plain themed <pre> (no syntax highlighter pulled in) to
 * keep memory low; mermaid blocks are post-processed from the sanitized DOM.
 */

marked.setOptions({ gfm: true, breaks: false });

// Open links in the OS browser (main's setWindowOpenHandler → shell.openExternal),
// never navigate the app. Registered once at module load.
let hooksInstalled = false;
function installHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A" && node.getAttribute("href")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
}

/** Render any ```mermaid blocks in the sanitized DOM into inline SVG. Lazy: the
 *  mermaid bundle is fetched only when at least one block is present. */
async function renderMermaid(container: HTMLElement, alive: () => boolean): Promise<void> {
  const blocks = container.querySelectorAll<HTMLElement>("pre > code.language-mermaid");
  if (blocks.length === 0) return;
  let mermaid: typeof import("mermaid").default;
  try {
    mermaid = (await import("mermaid")).default;
  } catch {
    return; // mermaid failed to load — leave the raw code block as-is
  }
  if (!alive()) return;
  mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict", fontFamily: "var(--font-sans)" });
  let i = 0;
  for (const codeEl of Array.from(blocks)) {
    if (!alive()) return;
    const pre = codeEl.parentElement;
    if (!pre) continue;
    const src = codeEl.textContent ?? "";
    try {
      const { svg } = await mermaid.render(`md-mermaid-${i++}-${src.length}`, src);
      if (!alive()) return;
      const wrap = document.createElement("div");
      wrap.className = "md-mermaid";
      wrap.innerHTML = svg;
      pre.replaceWith(wrap);
    } catch (e) {
      const err = document.createElement("pre");
      err.className = "md-mermaid-error";
      err.textContent = `mermaid: ${(e as Error).message}`;
      pre.replaceWith(err);
    }
  }
}

export function MarkdownPreview({ source }: { source: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    installHooks();
    const el = ref.current;
    if (!el) return;
    let alive = true;
    const dirty = marked.parse(source) as string;
    el.innerHTML = DOMPurify.sanitize(dirty);
    void renderMermaid(el, () => alive);
    return () => {
      alive = false;
    };
  }, [source]);

  return (
    <div
      ref={ref}
      className="md-preview nowheel absolute inset-0 h-full w-full overflow-auto px-6 py-4"
    />
  );
}
