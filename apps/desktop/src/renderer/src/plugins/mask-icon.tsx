import type { KindIcon } from "../tiles/api";

/** A plugin's .svg drawn as the app's icons are: its shape, as a mask, in the text's colour. */
export function MaskIcon({ url, size = 16, className }: { url: string; size?: number; className?: string }) {
  const mask = `url("${url.replace(/"/g, "%22")}") center / contain no-repeat`;
  return <span aria-hidden className={className} style={{ display: "inline-block", width: size, height: size, flex: "none", background: "currentColor", mask, WebkitMask: mask }} />;
}

/** The same, as an icon component a list draws at its own size. */
export function maskIcon(url: string): KindIcon {
  return function PluginIcon({ size, className }) { return <MaskIcon url={url} size={size} className={className} />; };
}

/** The .svg a HiveHub listing carries as `{ image }`, or null when it carries none. */
export function catalogImage(icon: unknown): string | null {
  const image = (icon as { image?: unknown } | null)?.image;
  return typeof image === "string" && image.startsWith("data:image/svg+xml;base64,") ? image : null;
}
