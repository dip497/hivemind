import { tileKindAvailability } from "@hivemind/core/tool-plugins";
import { getSettings, useSettings } from "./settings-store";
import { toast } from "sonner";

export function toolCreationAllowed(kind: string): boolean {
  const result = tileKindAvailability(kind, getSettings().tools);
  return result === null || result.available;
}
export function useToolEnabled(kind: string): boolean {
  const settings = useSettings();
  const result = tileKindAvailability(kind, settings.tools);
  return result === null || result.available;
}
export function checkToolCreation(kind: string): boolean {
  if (toolCreationAllowed(kind)) return true;
  toast.error("Browser is disabled. Enable it in Settings under Tools.", {
    id: "browser-disabled",
    action: { label: "Settings", onClick: () => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "tools" } })) },
  });
  return false;
}
