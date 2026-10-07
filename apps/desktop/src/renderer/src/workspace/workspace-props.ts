/** The workspace the tiles are in, as the active view is handed it: what a plugin tile's `hm` shows. */
import { createContext } from "react";
import type { WorkspaceViewProps } from "./workspace-view";

export const WorkspacePropsContext = createContext<WorkspaceViewProps | null>(null);
