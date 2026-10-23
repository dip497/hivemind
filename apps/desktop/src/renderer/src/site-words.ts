/**
 * How a Browser tile names a site and what it asks for: in the prompt a page's ask shows
 * (browser-asks.tsx) and in the site's panel (browser-site.tsx).
 */

/** A site (an origin) as the person reads it, in two parts. `tail` is its registrable domain and
 *  port, which is always shown; `head` is the rest (the scheme when it is not https, and the
 *  subdomains), which a narrow tile cuts from the left. A site can make its name long, never hide
 *  whose it is. */
export function siteParts(site: string): { head: string; tail: string } {
  let url: URL;
  try { url = new URL(site); } catch { return { head: "", tail: site }; }
  const scheme = url.protocol === "https:" ? "" : `${url.protocol}//`;
  const port = url.port ? `:${url.port}` : "";
  const host = url.hostname;
  // An address or a one-word name: all of it is the end.
  if (host.startsWith("[") || /^[\d.]+$/.test(host) || !host.includes(".")) return { head: scheme, tail: host + port };
  const labels = host.split(".");
  // The last two names, or three where the last two read as a country's own (example.co.uk).
  const keep = labels.length > 2 && labels.at(-1)!.length === 2 && labels.at(-2)!.length <= 3 ? 3 : 2;
  return { head: scheme + labels.slice(0, -keep).map((label) => `${label}.`).join(""), tail: labels.slice(-keep).join(".") + port };
}

/** What a right lets a site do, after "wants to". */
const DOES: Record<string, string> = {
  geolocation: "know your location",
  notifications: "show notifications",
  "clipboard-read": "see what you copied",
  "idle-detection": "know when you are away",
  "window-management": "place windows on your screens",
  midi: "use your MIDI devices",
  midiSysex: "control your MIDI devices",
};

/** A right that opens a link of one scheme in another program: the scheme, else null. */
function opens(right: string): string | null {
  return right.startsWith("openExternal:") ? right.slice("openExternal:".length) : null;
}

/** What a page asking for `rights` wants to do, as in "example.com wants to …". */
export function wants(rights: readonly string[]): string {
  const media = rights.filter((right) => right === "camera" || right === "microphone");
  if (media.length) return `use your ${media.join(" and ")}`;
  return rights.map((right) => {
    const scheme = opens(right);
    return scheme ? `open ${scheme}: links in another program` : DOES[right] ?? `use ${right}`;
  }).join(" and ");
}

const NAMES: Record<string, string> = {
  notifications: "Notifications",
  camera: "Camera",
  microphone: "Microphone",
  geolocation: "Location",
  "clipboard-read": "Read what you copied",
  "idle-detection": "Know when you are away",
  "window-management": "Place windows",
  midi: "MIDI devices",
  midiSysex: "Control MIDI devices",
};

/** A right's name in the site's panel. */
export function rightName(right: string): string {
  const scheme = opens(right);
  return scheme ? `Open ${scheme}: links` : NAMES[right] ?? right;
}
