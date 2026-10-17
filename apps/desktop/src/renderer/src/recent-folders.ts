/**
 * The folders the person opened lately, here and on each machine, as the windows keep them: main
 * is told them whole each time one is added, and the person's phone starts agents there.
 */
import { machineUri } from "@hivemind/core/remote-uri";

const LOCAL = "hivemind:recent-projects";
const MACHINE = "hivemind:machine-recent:";

const listed = (key: string): string[] => {
  try {
    const v = JSON.parse(window.localStorage.getItem(key) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

export function tellRecentFolders(): void {
  const folders = listed(LOCAL);
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i);
    if (key?.startsWith(MACHINE)) folders.push(...listed(key).map((dir) => machineUri(key.slice(MACHINE.length), dir)));
  }
  window.hive.recentFolders(folders);
}
