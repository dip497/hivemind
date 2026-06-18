/**
 * Per-tile error boundary. A tile is arbitrary React (xterm, the pierre diff
 * CodeView, CodeMirror …) and any one of them can throw during render. Without
 * a boundary a single throw unmounts the WHOLE React tree — the entire canvas
 * goes black, taking every other (healthy) tile with it. That actually happened
 * with a diff tile carrying stale persisted comments.
 *
 * This isolates the blast radius to one tile: the rest of the canvas keeps
 * working, and the broken tile shows a readable fallback (with the error and a
 * Retry) instead of a black screen. PTY sessions are untouched — they live in
 * the daemon, not this component.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  /** Tile name for the fallback header (e.g. "Diff", "claude #2"). */
  label?: string;
  /** Close/remove the tile from the fallback. */
  onClose?: () => void;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

// A lazy/dynamic chunk that 404s — almost always a STALE BUILD: the running
// window references an old `assets/<name>-<hash>.js` that a rebuild replaced.
// Re-rendering re-requests the same dead hash, so the only cure is reloading the
// window (which re-reads index.html and its fresh hashes). PTY sessions survive
// (they live in the daemon, not the renderer).
function isStaleChunkError(error: Error): boolean {
  const m = `${error?.name ?? ""} ${error?.message ?? ""}`;
  return (
    /ChunkLoadError/i.test(m) ||
    /failed to fetch dynamically imported module/i.test(m) ||
    /error loading dynamically imported module/i.test(m) ||
    /importing a module script failed/i.test(m)
  );
}

export class TileErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface it for diagnosis — visible in devtools + the renderer log.
    console.error(`[hivemind] tile "${this.props.label ?? "?"}" crashed:`, error, info.componentStack);
  }

  private retry = (): void => this.setState({ error: null });

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const stale = isStaleChunkError(error);
    return (
      <div className="flex h-full w-full flex-col rounded-xl border border-[var(--color-err)] bg-[var(--color-bg2)] overflow-hidden">
        <div className="h-8 flex items-center gap-2 px-2.5 bg-[var(--color-bg3)] border-b border-[var(--color-line)] text-[11px] font-mono text-[var(--color-err)]">
          <span>⚠ {this.props.label ?? "tile"} {stale ? "needs a reload (stale build)" : "crashed"}</span>
          <div className="ml-auto flex items-center gap-1">
            {stale ? (
              <button
                onClick={() => window.location.reload()}
                className="nodrag h-6 px-2 rounded text-[var(--color-fg)] bg-[var(--color-bg)] hover:bg-[var(--color-bg3)]"
                title="Reload the window to pick up the new build (PTY sessions survive)"
              >
                Reload
              </button>
            ) : (
              <button
                onClick={this.retry}
                className="nodrag h-6 px-2 rounded text-[var(--color-fg2)] hover:bg-[var(--color-bg)] hover:text-[var(--color-fg)]"
                title="Re-render this tile"
              >
                Retry
              </button>
            )}
            {this.props.onClose && (
              <button
                onClick={this.props.onClose}
                className="nodrag h-6 px-2 rounded text-[var(--color-fg3)] hover:bg-[var(--color-bg)] hover:text-[var(--color-err)]"
                title="Remove this tile"
              >
                Close
              </button>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-auto p-3">
          <pre className="text-[11px] leading-relaxed text-[var(--color-fg2)] whitespace-pre-wrap break-words">
            {error.message}
            {error.stack ? `\n\n${error.stack}` : ""}
          </pre>
        </div>
      </div>
    );
  }
}
