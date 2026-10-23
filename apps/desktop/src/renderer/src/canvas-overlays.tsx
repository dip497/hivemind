/**
 * Canvas overlays — the empty-canvas call-to-action. Pure presentational;
 * driven by props (Canvas owns the spawn actions). Extracted to keep
 * Canvas.tsx focused.
 */
import { SquarePen } from "./components/icons";
import { AgentIcon } from "./agents";
import { Button } from "./components/ui/button";
import { openMachines } from "./machines/store";

export function CanvasEmptyState({
  repoPath,
  onShowTree,
  onShowShell,
  agentId,
  agentLabel,
  onSpawnAgent,
}: {
  repoPath: string | null;
  onShowTree: () => void;
  onShowShell: () => void;
  /** The default agent; null when no agent CLI is installed here. */
  agentId: string | null;
  agentLabel: string | null;
  /** Start the default agent, or open Settings to get one. */
  onSpawnAgent: () => void;
}) {
  const folder = repoPath?.split(/[\\/]/).filter(Boolean).pop() ?? null;
  // One action leads, as in the Layers panel (New agent, 2); the rest are a quiet row.
  const secondary = [
    { label: "Open folder", hint: "", action: () => window.dispatchEvent(new CustomEvent("hivemind:open-folder")), disabled: false },
    { label: "Open terminal", hint: "1", action: onShowShell, disabled: false },
    { label: "Open code", hint: "3", action: onShowTree, disabled: !repoPath },
    { label: "Machines", hint: "", action: () => openMachines({ kind: "manage" }), disabled: false },
  ];
  // Home, before any workspace: a code from another computer, a phone's offer or an invite.
  if (!repoPath) secondary.push({ label: "Have a code? Join", hint: "", action: () => window.dispatchEvent(new CustomEvent("hivemind:open-recent", { detail: { join: true } })), disabled: false });
  return (
    <div className="pointer-events-none absolute inset-0 grid place-items-center">
      <div className="pointer-events-auto w-full max-w-[460px] px-8" data-canvas-empty>
        <h2 className="text-heading font-semibold text-[var(--color-fg)] tracking-tight leading-tight">
          Start with an agent.
        </h2>
        <p className="text-body text-[var(--color-fg2)] mt-1.5 leading-relaxed">
          {!agentLabel
            ? <>No agent CLI is installed on this machine yet. Get one, or open a tool below.</>
            : folder
              ? <>Each agent works in <span className="font-medium text-[var(--color-fg)]">{folder}</span>, in its own tile.</>
              : <>Each agent works in its own tile. Open a folder to give it one.</>}
        </p>

        <button
          type="button"
          onClick={onSpawnAgent}
          data-canvas-empty-agent
          className="mt-5 w-full flex items-center gap-3 rounded-xl border border-[var(--color-line2)] bg-[var(--color-bg3)] hover:border-[var(--color-brand)] hover:bg-[var(--color-bg4)] transition-colors duration-150 px-3.5 py-3 text-left group"
        >
          <span aria-hidden className="grid place-items-center size-9 shrink-0 rounded-lg bg-[var(--color-bg4)] text-[var(--color-fg)]">
            {agentId ? <AgentIcon id={agentId} size={20} /> : <SquarePen size={18} />}
          </span>
          <span className="flex-1 min-w-0">
            <span className="block text-row font-medium text-[var(--color-fg)]">{agentLabel ? "New agent" : "Get an agent"}</span>
            <span className="block text-label text-[var(--color-fg2)] leading-snug">{agentLabel ? `${agentLabel}, in its own tile` : "See which agents Hivemind works with, and how to install one"}</span>
          </span>
          {agentLabel && <kbd className="font-mono text-count text-[var(--color-fg2)] shrink-0">2</kbd>}
        </button>

        <div className="mt-3 flex flex-wrap items-center gap-1">
          {secondary.map((s) => (
            <Button
              key={s.label}
              variant="ghost"
              size="xs"
              onClick={s.action}
              disabled={s.disabled}
              title={s.disabled ? "Open a folder first" : s.label}
            >
              {s.label}
              {s.hint && <kbd className="font-mono text-chip">{s.hint}</kbd>}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
