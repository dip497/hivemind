/**
 * The window's sound player: one per window (useSounds mounts it). Main's notice desk picks the
 * window and the moment (`notify:sound`); this plays it and answers what became of it.
 *
 * - One AudioContext, made on the first sound, resumed on the person's first press or key (a
 *   window may not start sound before), and one gain at the settings' volume.
 * - Each sound is made or decoded once and kept: a built-in from its recipe (synth.ts), a theme's
 *   from its file, which main hands over (a window cannot fetch `hivemedia:`), cut to 3 s and
 *   leveled to −6 dBFS (level.ts).
 * - A theme sound that cannot be read or decoded plays the built-in, and says why.
 */
import type { NoticeKind } from "../../../shared/notification-settings";
import type { SoundRequest, SoundResult } from "../../../shared/ipc";
import { SAMPLE_RATE, synth } from "./synth";
import { leveled } from "./level";

/** How long the player waits for a suspended context to resume. */
const RESUME_MS = 300;

export class SoundPlayer {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private readonly builtIn = new Map<NoticeKind, AudioBuffer>();
  /** Per theme URL: its buffer, or why it cannot play. */
  private readonly themed = new Map<string, Promise<AudioBuffer | string>>();

  constructor(private readonly themeBytes?: (url: string) => Promise<Uint8Array>) {}

  /** The person pressed or typed: a suspended context may resume now. */
  wake(): void {
    if (this.ctx?.state === "suspended") void this.ctx.resume().catch(() => {});
  }

  async play(req: SoundRequest): Promise<SoundResult> {
    const ctx = this.context();
    if (!ctx) return { id: req.id, played: false, why: "no audio device" };
    if (ctx.state === "suspended") {
      await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, RESUME_MS))]);
      if ((ctx.state as AudioContextState) === "suspended") return { id: req.id, played: false, why: "suspended: click or type in the window once" };
    }
    let buffer: AudioBuffer | undefined;
    let why: string | undefined;
    if (req.theme) {
      const got = await this.theme(ctx, req.theme.url);
      if (typeof got === "string") why = `${req.theme.pack}'s sound did not play (${got}); the built-in one did`;
      else buffer = got;
    }
    const pack = buffer ? req.theme?.pack : undefined;
    buffer ??= this.builtInOf(ctx, req.moment);
    this.gain!.gain.value = Math.min(1, Math.max(0, req.volume));
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.gain!);
    src.start();
    return { id: req.id, played: true, ...(why ? { why } : {}), ...(pack ? { pack } : {}) };
  }

  private context(): AudioContext | null {
    if (this.ctx) return this.ctx;
    try {
      this.ctx = new AudioContext();
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
    } catch {
      this.ctx = null;
    }
    return this.ctx;
  }

  private builtInOf(ctx: AudioContext, moment: NoticeKind): AudioBuffer {
    let b = this.builtIn.get(moment);
    if (!b) {
      const samples = synth(moment);
      b = ctx.createBuffer(1, samples.length, SAMPLE_RATE);
      b.copyToChannel(samples, 0);
      this.builtIn.set(moment, b);
    }
    return b;
  }

  private theme(ctx: AudioContext, url: string): Promise<AudioBuffer | string> {
    let p = this.themed.get(url);
    if (!p) {
      p = (async () => {
        if (!this.themeBytes) return "this window cannot read it";
        let bytes: Uint8Array;
        try { bytes = await this.themeBytes(url); } catch { return "its file could not be read"; }
        let decoded: AudioBuffer;
        try { decoded = await ctx.decodeAudioData(bytes.slice().buffer); } catch { return "its file is not a sound this app can decode"; }
        const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i));
        const out = leveled(channels, decoded.sampleRate);
        const b = ctx.createBuffer(out.length, Math.max(1, out[0]!.length), decoded.sampleRate);
        out.forEach((ch, i) => b.copyToChannel(ch, i));
        return b;
      })();
      this.themed.set(url, p);
    }
    return p;
  }
}
