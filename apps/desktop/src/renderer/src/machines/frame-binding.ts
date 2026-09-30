/**
 * A frame's folder on another computer names the saved machine it is on (R9:
 * `machine://<id>/path`). A frame still bound by a machine's address — a workspace from before
 * R9, or a host saved as a machine since — is bound to that machine; one on a machine removed goes
 * back to its address, so it still runs there and can be saved as a machine again.
 */
import { bindToMachine, unbindFromMachine, type BindableMachine } from "../../../shared/remote-uri";

interface Bound { workspacePath?: string; worktreePath?: string }

/** `frames` with their folders bound as above; `frames` itself when none changes. */
export function rebindFrames<F extends Bound>(frames: F[], machines: readonly BindableMachine[], gone: readonly BindableMachine[]): F[] {
  const rebind = (p: string | undefined): string | undefined => {
    let q = p;
    for (const m of gone) q = unbindFromMachine(q, m);
    return bindToMachine(q, machines);
  };
  let changed = false;
  const next = frames.map((f) => {
    const workspacePath = rebind(f.workspacePath);
    const worktreePath = rebind(f.worktreePath);
    if (workspacePath === f.workspacePath && worktreePath === f.worktreePath) return f;
    changed = true;
    return { ...f, ...(workspacePath !== undefined ? { workspacePath } : {}), ...(worktreePath !== undefined ? { worktreePath } : {}) };
  });
  return changed ? next : frames;
}
