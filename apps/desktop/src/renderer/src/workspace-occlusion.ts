import { useSyncExternalStore } from "react";

// Fullscreen Settings hides decoration, but must never suspend agent sessions.
// Kept outside the persisted theme so closing Settings restores the user's choice.
// Per source (Settings, a fullscreen tile), so one closing does not uncover the other.
const sources = new Set<string>();
let occluded = false;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const snapshot = () => occluded;

export function setWorkspaceOccluded(value: boolean, source = "settings"): void {
  if (value) sources.add(source); else sources.delete(source);
  if (occluded === sources.size > 0) return;
  occluded = sources.size > 0;
  for (const listener of listeners) listener();
}

export const useWorkspaceOccluded = (): boolean => useSyncExternalStore(subscribe, snapshot, snapshot);
