/**
 * view-host — renders the active view plugin behind a crash boundary.
 *
 * The TileHost (every live session) sits OUTSIDE this boundary in Workspace.tsx,
 * so a view that throws during render takes down its arrangement chrome only —
 * terminals, editors and browsers keep running in the park and re-appear the
 * moment another view's slots adopt them. On a crash the runtime is told which
 * view failed and switches to the fallback; if the FALLBACK itself is what
 * failed (or nothing is registered), we show the failure panel with the other
 * views as escape hatches instead of a white screen.
 */
import { Component, Suspense, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { getView, listViews, type WorkspaceViewProps } from "./workspace-view";

class ViewErrorBoundary extends Component<
  { viewId: string; onError: (viewId: string, err: Error) => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err: Error, info: ErrorInfo) {
    console.error(`[hivemind] view "${this.props.viewId}" crashed`, err, info.componentStack);
    this.props.onError(this.props.viewId, err);
  }
  render() { return this.state.failed ? null : this.props.children; }
}

export function ViewFailure({ viewId, error, onSwitch, onRetry }: {
  viewId: string | null;
  error: Error | null;
  onSwitch: (id: string) => void;
  onRetry: () => void;
}) {
  const others = listViews().filter((v) => v.id !== viewId);
  return (
    <div className="flex-1 min-h-0 grid place-items-center p-6" role="alert" data-view-failure>
      <div className="max-w-[440px] rounded-xl border border-[var(--color-line)] bg-[var(--color-bg2)] p-4 shadow-2xl">
        <div className="flex items-center gap-2 text-[13px] font-medium text-[var(--color-fg)]">
          <AlertTriangle size={15} className="text-[var(--color-err)]" aria-hidden />
          {viewId ? <>View “{viewId}” failed</> : <>No workspace view is available</>}
        </div>
        <p className="mt-1.5 text-[12px] leading-snug text-[var(--color-fg2)]">
          Your tiles and agent sessions are still running — only the layout crashed.
          {error?.message ? <> <code className="font-mono text-[11px] text-[var(--color-fg3)]">{error.message}</code></> : null}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {viewId && (
            <button onClick={onRetry} className="px-2.5 py-1.5 rounded-lg text-[12px] hm-island text-[var(--color-fg)] hover:bg-[var(--color-bg3)]">
              Retry
            </button>
          )}
          {others.map((v) => (
            <button key={v.id} onClick={() => onSwitch(v.id)} className="px-2.5 py-1.5 rounded-lg text-[12px] hm-island text-[var(--color-fg)] hover:bg-[var(--color-bg3)]">
              Switch to {v.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Render `viewId`'s plugin. `attempt` is bumped by the runtime to remount the
 * boundary after a crash (Retry); the boundary is also keyed on the view id so
 * switching away from a crashed view always starts clean. A plugin's component
 * may be `React.lazy` (a heavy view — Three.js — must not ship in the default
 * chunk); the Suspense fallback is deliberately empty so the switch reads as
 * instant once the chunk is cached.
 */
export function ViewHost({ viewId, attempt, props, onError, failed, onSwitch, onRetry }: {
  viewId: string | null;
  attempt: number;
  props: WorkspaceViewProps;
  onError: (viewId: string, err: Error) => void;
  /** Set when `viewId` is the one that crashed and there's nothing to fall back to. */
  failed: Error | null;
  onSwitch: (id: string) => void;
  onRetry: () => void;
}) {
  const plugin = viewId ? getView(viewId) : undefined;
  if (!plugin || failed) {
    return <ViewFailure viewId={viewId} error={failed} onSwitch={onSwitch} onRetry={onRetry} />;
  }
  const View = plugin.component;
  return (
    <ViewErrorBoundary key={`${plugin.id}:${attempt}`} viewId={plugin.id} onError={onError}>
      <Suspense fallback={<div className="flex-1 min-h-0" aria-busy="true" />}>
        <View {...props} />
      </Suspense>
    </ViewErrorBoundary>
  );
}
