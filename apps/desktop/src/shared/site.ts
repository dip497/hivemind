/** The site a URL belongs to, as a Browser tile's page is asked about and its answers are kept
 *  (main/permissions.ts) and as its panel names it: its origin, or null when it has none to name
 *  (a sandboxed frame, a data: page). */
export function siteOf(url: string): string | null {
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}
