import { LayoutGrid } from "lucide-react";
import type { WidgetPackage } from "../../../shared/ipc";

/** A widget's mark: a one-colour SVG drawn in the text colour (a mask, so it follows the theme like
 *  the app's own icons), any other image as it is, and a grid for one that has none. */
export function WidgetIcon({ pkg, size = 16 }: { pkg: Pick<WidgetPackage, "icon"> | undefined; size?: number }) {
  const icon = pkg?.icon;
  if (!icon) return <LayoutGrid size={size} />;
  if (icon.startsWith("data:image/svg+xml")) {
    const mask = `url("${icon.replace(/"/g, "%22")}") center / contain no-repeat`;
    return <span aria-hidden="true" data-widget-icon className="inline-block shrink-0 bg-current" style={{ width: size, height: size, mask, WebkitMask: mask }} />;
  }
  return <img aria-hidden="true" alt="" data-widget-icon src={icon} width={size} height={size} className="shrink-0 object-contain" />;
}
