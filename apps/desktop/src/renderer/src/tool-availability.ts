import { bundledToolRegistry, tileKindAvailability, toolIdForTileKind } from "@hivemind/core/tool-plugins";
import { getSettings, useSettings } from "./settings-store";
import { toolPreferences } from "@hivemind/core/settings-schema";
import { toast } from "sonner";
import { kindsThatOpen, type TileIntent } from "./tiles/api";

export function toolCreationAllowed(kind: string): boolean {
  const result = tileKindAvailability(kind, toolPreferences(getSettings()));
  return result === null || result.available;
}
/** The kinds that take what another tile hands over now: none switched off. */
export const kindsThatOpenNow = (intent: TileIntent): string[] => kindsThatOpen(intent).filter(toolCreationAllowed);
export function useToolEnabled(kind: string): boolean {
  const settings = useSettings();
  const result = tileKindAvailability(kind, toolPreferences(settings));
  return result === null || result.available;
}
export function checkToolCreation(kind: string): boolean {
  if (toolCreationAllowed(kind)) return true;
  const toolId = toolIdForTileKind(kind);
  const label = bundledToolRegistry.tools.find((t) => t.id === toolId)?.label ?? "That tool";
  const pluginId = toolId?.slice(0, toolId.lastIndexOf("/"));
  toast.error(`${label} is disabled. Switch it on in Settings ▸ Plugins.`, {
    id: `${toolId ?? kind}-disabled`,
    action: { label: "Settings", onClick: () => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: pluginId ? `plugin:tool:${pluginId}` : "plugins" } })) },
  });
  return false;
}
