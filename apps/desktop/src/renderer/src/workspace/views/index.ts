/**
 * Built-in view plugins. Registration order = ⌘E cycle order = Settings order.
 * Importing this module registers them; Workspace.tsx imports it for the side
 * effect. Community plugins do NOT register here — see the design doc for the
 * isolated-loading phase.
 */
import { registerView } from "../workspace-view";
import { canvasViewPlugin } from "./CanvasView";
import { windowsViewPlugin } from "./WindowsView";

export function registerBuiltinViews(): void {
  registerView(canvasViewPlugin);
  registerView(windowsViewPlugin);
}

registerBuiltinViews();
