/** The owner's selected view is a workspace preference. A guest takes it on opening the
 * workspace, then chooses freely; their own settings and later view switches remain local. */
import { useEffect, useRef } from "react";
import { joinedId } from "../multiplayer/shown";
import { onStoreChange, readView, writeView } from "./workspace-store-client";
import { setViewMode } from "./view-mode-store";

export const SHARED_DEFAULT_VIEW = "workspace-default";

export function sharedDefaultView(repo: string): string | null {
  const value = readView(repo, SHARED_DEFAULT_VIEW);
  return value?.v === 1 && typeof value.data === "string" && value.data.length > 0 ? value.data : null;
}

export function useSharedDefaultView(repo: string | null, active: string | null): void {
  const taken = useRef<string | null>(null);
  useEffect(() => {
    if (!repo) return;
    if (!joinedId(repo)) {
      if (active && sharedDefaultView(repo) !== active) writeView(repo, SHARED_DEFAULT_VIEW, { v: 1, data: active });
      return;
    }
    if (taken.current === repo) return;
    const take = () => {
      if (taken.current === repo) return;
      const id = sharedDefaultView(repo);
      if (!id) return;
      taken.current = repo;
      setViewMode(id, false);
    };
    take();
    return onStoreChange(({ repo: changed, part }) => {
      if (changed === repo && part === `view:${SHARED_DEFAULT_VIEW}`) take();
    });
  }, [repo, active]);
}
