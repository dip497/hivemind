/**
 * One file's header inside the diff: collapse, stage, path, ±counts, viewed,
 * open, discard. `data-diff-file` is what the comment gutter resolves a
 * clicked line back to a file with.
 */
export function DiffHeader(props: {
  h: number;
  fontPx: number;
  file: string;
  adds: number;
  dels: number;
  staged: boolean;
  collapsed: boolean;
  viewed: boolean;
  showStage: boolean;
  onToggleCollapsed: () => void;
  onToggleViewed: () => void;
  onToggleStage: () => void;
  onOpen: () => void;
  onDiscard: () => void;
}) {
  return (
    <div
      // The comment gutter resolves which file a clicked line belongs to by
      // finding the nearest preceding header in document order — this attribute is
      // that anchor (robust to Pierre's gutter API not carrying the file id).
      data-diff-file={props.file}
      className={`flex items-center gap-2 px-2.5 w-full font-mono bg-[var(--color-bg3)] border-b border-[var(--color-line)] ${
        props.viewed ? "opacity-55" : ""
      }`}
      style={{ height: props.h, fontSize: props.fontPx }}
    >
      <button
        title={props.collapsed ? "expand" : "collapse"}
        onClick={(e) => {
          e.stopPropagation();
          props.onToggleCollapsed();
        }}
        className="text-[var(--color-fg3)] hover:text-[var(--color-fg)] w-3 text-[0.82em]"
      >
        {props.collapsed ? "▸" : "▾"}
      </button>

      {props.showStage && (
        <button
          title={props.staged ? "unstage" : "stage"}
          onClick={(e) => {
            e.stopPropagation();
            props.onToggleStage();
          }}
          style={{
            width: 14,
            height: 14,
            borderRadius: 3,
            border: props.staged ? "1px solid var(--color-ok)" : "1px solid var(--color-line2)",
            background: props.staged ? "var(--color-ok)" : "transparent",
            color: props.staged ? "var(--color-bg)" : "transparent",
            fontSize: "0.82em",
            lineHeight: "12px",
          }}
        >
          ✓
        </button>
      )}

      <span className="text-[var(--color-fg)] truncate" title={props.file}>{props.file}</span>
      <span style={{ color: "var(--color-ok)" }}>+{props.adds}</span>
      <span style={{ color: "var(--color-err)" }}>−{props.dels}</span>

      <span className="ml-auto inline-flex items-center gap-2">
        <button
          title="mark viewed"
          onClick={(e) => {
            e.stopPropagation();
            props.onToggleViewed();
          }}
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[0.92em] transition-colors ${
            props.viewed
              ? "border-[var(--color-ok)] text-[var(--color-ok)]"
              : "border-[var(--color-line2)] text-[var(--color-fg3)] hover:text-[var(--color-fg2)]"
          }`}
        >
          {props.viewed ? "✓ viewed" : "viewed"}
        </button>
        <button
          title="open file in viewer"
          onClick={(e) => {
            e.stopPropagation();
            props.onOpen();
          }}
          className="px-1.5 py-0.5 rounded border border-[var(--color-line2)] text-[var(--color-fg2)] text-[0.92em]"
        >
          ↗ open
        </button>
        {props.showStage && (
          <button
            title="discard changes"
            onClick={(e) => {
              e.stopPropagation();
              props.onDiscard();
            }}
            className="px-1.5 py-0.5 rounded border border-[var(--color-line2)] text-[var(--color-err)] text-[0.92em]"
          >
            ⌫
          </button>
        )}
      </span>
    </div>
  );
}

// ── single-file CodeView popup (header "↗ open") ──────────────────────────
