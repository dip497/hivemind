import { promisify } from "node:util";
import { deflateRaw } from "node:zlib";
import type { TextChannel } from "@hivemind/workspace-api/peers";

export const SQUEEZE_OFFER = "deflate";
export const SQUEEZE_OVER = 16 * 1024;

const deflate = promisify(deflateRaw);

export function squeezed(channel: TextChannel): TextChannel {
  let queued = 0;
  let last: Promise<void> = Promise.resolve();
  return {
    send(text) {
      if (!queued && text.length <= SQUEEZE_OVER) return channel.send(text);
      queued++;
      const out = text.length > SQUEEZE_OVER
        ? deflate(text).then((z) => `z:${z.toString("base64")}`, () => text)
        : Promise.resolve(text);
      last = last.then(() => out).then((t) => { queued--; channel.send(t); });
    },
    on: (listener) => channel.on(listener),
    closed: channel.closed,
  };
}
