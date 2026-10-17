// The phone page a network's server serves (`hive-net serve --phone`, docs/design/phone-browser-
// 2026-10-03.md §10): where it is, and its hash, worked out from what the server serves as
// crates/hive-web/build.sh works it out from what it built.
import { createHash } from "node:crypto";
import { formatConnectLink, type ConnectLink } from "@hivemind/workspace-host/connect";

/** The page beside `relay`, when its server serves one (3 s at most to say). */
export async function phonePageAt(relay: string | null): Promise<string | null> {
  if (!relay) return null;
  const page = new URL("phone/", relay.endsWith("/") ? relay : `${relay}/`).href;
  try {
    const answer = await fetch(new URL("manifest.webmanifest", page), { signal: AbortSignal.timeout(3000) });
    return answer.ok ? page : null;
  } catch {
    return null;
  }
}

/** The page's address with the offer to connect `link` in its fragment: the computer's addresses,
 *  which a browser cannot use, left out, so the QR code a phone's camera reads is smaller. */
export const connectPageLink = (page: string, link: ConnectLink): string => `${page}#connect=${formatConnectLink({ ...link, addrs: [] })}`;

/** The hash of the page at `page`: each file it runs or keeps (`index.html`, `sw.js` and what its
 *  `shell.json` lists), as `sha256sum` lists them, in name order, hashed. */
export async function pageHash(page: string, timeout = 30_000): Promise<string> {
  const signal = AbortSignal.timeout(timeout);
  const get = async (name: string): Promise<Buffer> => {
    const answer = await fetch(new URL(name, page), { signal });
    if (!answer.ok) throw new Error(`${name}: ${answer.status}`);
    return Buffer.from(await answer.arrayBuffer());
  };
  const shell = JSON.parse((await get("shell.json")).toString("utf8")) as string[];
  const names = ["index.html", "sw.js", ...shell.filter((n) => n !== "./")].sort();
  const files = await Promise.all(names.map(get));
  const listed = names.map((n, i) => `${createHash("sha256").update(files[i]!).digest("hex")}  ${n}\n`).join("");
  return createHash("sha256").update(listed).digest("hex");
}

declare const __PHONE_PAGE__: string | null;
/** The hash of the page this build goes with; null for a build made without one. */
export const SHIPPED_PAGE: string | null = typeof __PHONE_PAGE__ === "undefined" ? null : __PHONE_PAGE__;
