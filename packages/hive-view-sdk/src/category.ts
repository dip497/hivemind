/** What a plugin is for, one of a fixed few: the app groups views, tools and widgets by it and
 *  HiveHub lists them by it. A manifest without one is `other`. */
export const PLUGIN_CATEGORIES = ["code", "git", "agents", "productivity", "monitoring", "team", "web", "fun", "other"] as const;
export type PluginCategory = (typeof PLUGIN_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<PluginCategory, string> = {
  code: "Code", git: "Git", agents: "Agents", productivity: "Productivity", monitoring: "Monitoring",
  team: "Team", web: "Web", fun: "Fun", other: "Other",
};

/** A manifest's `category`, or why it is not one. */
export function parseCategory(raw: unknown): { category: PluginCategory } | { error: string } {
  if (raw === undefined) return { category: "other" };
  return typeof raw === "string" && (PLUGIN_CATEGORIES as readonly string[]).includes(raw)
    ? { category: raw as PluginCategory }
    : { error: `"category" must be one of ${PLUGIN_CATEGORIES.join(", ")}` };
}
