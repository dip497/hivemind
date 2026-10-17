/**
 * The view drawn inside the app: the canvas. Every other view is a view package, the ones that
 * come with the app included (apps/desktop/views). Registration order = ⌘E cycle order = Settings order.
 * Importing this module registers them; Workspace.tsx imports it for the side
 * effect. Community plugins do NOT register here — see the design doc for the
 * isolated-loading phase.
 */
import { registerView } from "../workspace-view";
import { canvasViewPlugin } from "./CanvasView";

export function registerBuiltinViews(): void {
  registerView(canvasViewPlugin);
}

registerBuiltinViews();
