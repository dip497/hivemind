/**
 * The window's sound player, mounted once per window (App): plays what main's notice desk sends
 * this window and answers what became of it. Nothing runs until a sound comes.
 */
import { useEffect } from "react";
import { SoundPlayer } from "./player";

export function useSounds(): void {
  useEffect(() => {
    const hive = window.hive;
    if (!hive.onSound || !hive.soundResult) return;
    const player = new SoundPlayer(hive.themeSoundBytes);
    const wake = () => player.wake();
    window.addEventListener("pointerdown", wake, true);
    window.addEventListener("keydown", wake, true);
    const off = hive.onSound((req) => {
      void player.play(req)
        .catch((e: unknown) => ({ id: req.id, played: false, why: e instanceof Error ? e.message : "it did not play" }))
        .then((r) => hive.soundResult?.(r));
    });
    return () => {
      off();
      window.removeEventListener("pointerdown", wake, true);
      window.removeEventListener("keydown", wake, true);
    };
  }, []);
}
