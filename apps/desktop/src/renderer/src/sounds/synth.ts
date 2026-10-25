/**
 * The built-in sounds, made from their recipe the first time each is played: no asset files.
 *   needs you: two rising sine notes, E5 then A5, 90 ms each, a 5 ms attack and a soft tail;
 *   finished:  one bell, A5 with a quiet octave, decaying over 0.6 s;
 *   failed:    two falling triangle notes, A3 then E3.
 * Each is leveled to −6 dBFS (level.ts), the loudest any sound here plays. Pure sample math, so it
 * is the same in every window and in a test.
 */
import type { NoticeKind } from "../../../shared/notification-settings";
import { leveled } from "./level";

export const SAMPLE_RATE = 44_100;

type Wave = "sine" | "triangle";
interface Note { hz: number; at: number; hold: number; tail: number; wave: Wave; gain: number }

const ATTACK = 0.005;

export const RECIPES: Record<NoticeKind, Note[]> = {
  needs: [
    { hz: 659.25, at: 0, hold: 0.09, tail: 0.08, wave: "sine", gain: 1 },
    { hz: 880, at: 0.09, hold: 0.09, tail: 0.12, wave: "sine", gain: 1 },
  ],
  done: [
    { hz: 880, at: 0, hold: 0, tail: 0.6, wave: "sine", gain: 1 },
    { hz: 1760, at: 0, hold: 0, tail: 0.4, wave: "sine", gain: 0.25 },
  ],
  error: [
    { hz: 220, at: 0, hold: 0.12, tail: 0.08, wave: "triangle", gain: 1 },
    { hz: 164.81, at: 0.14, hold: 0.14, tail: 0.16, wave: "triangle", gain: 1 },
  ],
};

const wave = (w: Wave, phase: number) => (w === "sine" ? Math.sin(2 * Math.PI * phase) : 2 * Math.abs(2 * (phase - Math.floor(phase + 0.5))) - 1);

/** The seconds a recipe lasts. */
export const lengthOf = (notes: readonly Note[]) => Math.max(...notes.map((n) => n.at + ATTACK + n.hold + n.tail));

/** `moment`'s built-in sound: mono samples at SAMPLE_RATE. */
export function synth(moment: NoticeKind): Float32Array<ArrayBuffer> {
  const notes = RECIPES[moment];
  const out = new Float32Array(Math.ceil(lengthOf(notes) * SAMPLE_RATE));
  for (const n of notes) {
    const start = Math.floor(n.at * SAMPLE_RATE);
    const total = Math.ceil((ATTACK + n.hold + n.tail) * SAMPLE_RATE);
    for (let i = 0; i < total && start + i < out.length; i++) {
      const t = i / SAMPLE_RATE;
      // Attack, hold, then an exponential tail down to about −60 dB.
      const env = t < ATTACK ? t / ATTACK : t < ATTACK + n.hold ? 1 : Math.exp((-6.9 * (t - ATTACK - n.hold)) / n.tail);
      out[start + i] = out[start + i]! + n.gain * env * wave(n.wave, n.hz * t);
    }
  }
  return leveled([out], SAMPLE_RATE)[0]!;
}
