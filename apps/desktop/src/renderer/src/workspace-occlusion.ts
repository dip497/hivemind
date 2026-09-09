import { useSyncExternalStore } from "react";

// Fullscreen Settings hides decoration, but must never suspend agent sessions.
// Kept outside the persisted theme so closing Settings restores the user's choice.
let occluded = false;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const snapshot = () => occluded;

export function setWorkspaceOccluded(value: boolean): void {
  if (occluded === value) return;
  occluded = value;
  for (const listener of listeners) listener();
}

export const useWorkspaceOccluded = (): boolean => useSyncExternalStore(subscribe, snapshot, snapshot);
