/**
 * Maps a claude `Notification` event's `notification_type` to the canonical
 * "needs-you" status the renderer surfaces, or null for types that don't change
 * tile status. Pure + tested so the mapping is one auditable place.
 *
 * claude's notification_type values (from the CLI bundle):
 *   permission_request / worker_permission_prompt → a tool wants approval
 *   elicitation*                                   → an interactive question
 *   idle_prompt                                    → "waiting for your input"
 *   auth_success / computer_use_* / push_*         → not status-relevant
 *
 * idle_prompt is intentionally NOT mapped: it fires only after a long idle delay
 * and the scrape already shows idle instantly, so an override would just fight
 * the scrape. We map the two ATTENTION states the scrape can miss on version
 * drift — permission and question.
 */
export type NeedsYouStatus = "permission" | "question";

export function notifyStatusFor(notificationType: string): NeedsYouStatus | null {
  const t = (notificationType ?? "").toLowerCase();
  if (t === "permission_request" || t === "worker_permission_prompt" || t.includes("permission"))
    return "permission";
  if (t.startsWith("elicitation")) return "question";
  return null;
}
