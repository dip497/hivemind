/**
 * A person as the people they work with see them (R3, M1): the colours a person can be, the one a
 * person who has not chosen gets (picked by their id, so it is the same on each of their devices
 * and to everyone who sees them), the letters their avatar shows, and what each role is called.
 */

/** What each role on a workspace is called (design §6). */
export const ROLE_LABELS: Record<string, string> = {
  view: "Can view", edit: "Can edit board", terminals: "Can use terminals", agents: "Can drive agents", owner: "Owner",
};

/** Distinct from one another, and legible on a dark or a light theme. */
export const PROFILE_COLORS: readonly { name: string; value: string }[] = [
  { name: "Red", value: "#ef4444" },
  { name: "Orange", value: "#f97316" },
  { name: "Yellow", value: "#eab308" },
  { name: "Green", value: "#22c55e" },
  { name: "Teal", value: "#14b8a6" },
  { name: "Blue", value: "#3b82f6" },
  { name: "Violet", value: "#8b5cf6" },
  { name: "Pink", value: "#ec4899" },
];

/** The colour of a person who has not chosen one. */
export function colorFor(personId: string): string {
  return PROFILE_COLORS[parseInt(personId.slice(0, 8), 16) % PROFILE_COLORS.length]!.value;
}

/** The colour someone is drawn in: theirs, or the one they get for not choosing. */
export function colorOf(p: { person: string; color: string }): string {
  return p.color || colorFor(p.person);
}

/** The letters of a name an avatar shows: a first and last initial, or the first two letters. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
}
