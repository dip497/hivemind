/**
 * The World view plugin — a Three.js scene of the workspace: one island per
 * frame, one object per tile, coloured by live agent status. The component is
 * `React.lazy`, so three.js and the scene code live in their own chunk
 * (`WorldView-*.js` + `vendor-three-*.js`) and the default canvas/windows path
 * never loads them; the ViewHost's Suspense covers the one-time chunk wait.
 *
 * Everything else about the view — the scene, docking a live tile, the layout
 * blob — is in WorldView.tsx / world-scene.ts / world-layout.ts.
 */
import { lazy } from "react";
import { Globe } from "lucide-react";
import type { WorkspaceViewPlugin } from "../../workspace-view";

export const WORLD_VIEW_ID = "world";

export const worldViewPlugin: WorkspaceViewPlugin = {
  id: WORLD_VIEW_ID,
  label: "World",
  hint: "A 3D map of your frames and agents — click a tile to land in it.",
  icon: Globe,
  component: lazy(() => import("./WorldView")),
};
