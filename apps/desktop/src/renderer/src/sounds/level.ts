/**
 * How loud and how long a sound may be: every sound the app plays peaks at PEAK (−6 dBFS) and lasts
 * at most MAX_SECONDS, so a theme's pack can never be louder or longer than the built-in sounds.
 * Pure: it works on the samples, so the player (and a test) gives it any decoded buffer.
 */

/** −6 dBFS. */
export const PEAK = 10 ** (-6 / 20);
export const MAX_SECONDS = 3;
/** The fade over a cut's last 20 ms, so it ends without a click. */
const FADE_SECONDS = 0.02;

/** `channels` (one Float32Array each, at `sampleRate`) cut to `MAX_SECONDS` and scaled so the loudest
 *  sample of any channel is `PEAK`. Silence stays silence. New arrays; the given ones are not changed. */
export function leveled(channels: readonly Float32Array[], sampleRate: number): Float32Array<ArrayBuffer>[] {
  const length = Math.min(channels[0]?.length ?? 0, Math.floor(MAX_SECONDS * sampleRate));
  const cut = length < (channels[0]?.length ?? 0);
  let max = 0;
  for (const ch of channels) for (let i = 0; i < length; i++) { const a = Math.abs(ch[i]!); if (a > max) max = a; }
  const gain = max > 0 ? PEAK / max : 0;
  const fade = cut ? Math.min(length, Math.floor(FADE_SECONDS * sampleRate)) : 0;
  return channels.map((ch) => {
    const out = new Float32Array(length);
    for (let i = 0; i < length; i++) out[i] = ch[i]! * gain * (i >= length - fade ? (length - 1 - i) / fade : 1);
    return out;
  });
}
