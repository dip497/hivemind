/**
 * The app's sounds on the drive socket (0.35): what became of one, and the bursts Recent lists.
 * The app's notice desk answers both (apps/desktop/src/main/notice-desk.ts); `hive host` has no
 * sounds, so it does not.
 */

import type { NoticeKind } from "@hivemind/core/notification-settings";

/** The moment a sound is for: the kind of change it tells. */
export type SoundMoment = NoticeKind;

/** What became of a sound. */
export interface SoundResult {
  id: number;
  played: boolean;
  /** Why it was blocked (`suspended`, `no audio device`, `no window open`), or why the theme's sound
   *  gave way to the built-in one. */
  why?: string;
  /** The applied theme whose sound played; none: the built-in sound. */
  pack?: string;
}

/** One burst of agents' changes of one kind, as Recent lists it. */
export interface RecentSound {
  id: number;
  moment: SoundMoment;
  /** How many agents. */
  agents: number;
  /** When it started (ms since the epoch). */
  at: number;
  /** How many OS pop-ups it showed. */
  popups: number;
  /** off: no sound for that moment; waiting: offered or asked for; skipped: another sound, or the
   *  person looking at the tile, took its place; played or blocked: what the window said. */
  sound: "off" | "waiting" | "skipped" | "played" | "blocked";
  why?: string;
  pack?: string;
  /** How many agents the sound stood for. */
  count?: number;
}
