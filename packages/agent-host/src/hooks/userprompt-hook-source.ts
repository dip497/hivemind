/**
 * The `UserPromptSubmit` hook source — emitted as `hcp-userprompt-hook.cjs`, run
 * by `claude` when a prompt is submitted (a turn STARTS). It reports turn-start to
 * the HCP socket so the tile reads `working` deterministically — no screen-scrape.
 *
 * Pairs with the existing `Stop` hook (turn END → idle): together they give claude
 * a hook-driven working/idle that is immune to the TUI's spinner-glyph / wording /
 * focus / scroll / buffer-replay churn the scrape kept mis-reading. The scrape is
 * demoted to a fallback for non-claude agents (which have no hooks).
 *
 * Built on the shared {@link eventHookSource} skeleton. Fire-and-forget; the
 * UserPromptSubmit payload ({ prompt, … }) is irrelevant — we only need the edge.
 */
import { eventHookSource } from "./event-hook-source.js";

export function userpromptHookSource(): string {
  return eventHookSource("status", `return { tileId: tileId, state: "working" };`);
}
