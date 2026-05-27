import os from "node:os";

/** Best-effort "who is doing this CLI call" for the Activity log. */
export function detectWho(): string {
  return (
    process.env.HIVE_WHO ||
    process.env.GIT_AUTHOR_NAME ||
    process.env.USER ||
    os.userInfo().username ||
    "anon"
  );
}
