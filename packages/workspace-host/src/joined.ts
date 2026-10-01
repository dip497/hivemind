/**
 * The workspaces this person joined elsewhere (M1; design §4.2 B, F): where each one's host is,
 * the role they were last given, the names to show, and whether they left or were removed, kept
 * in one private file so the app can open them again ("Recent shared").
 */
import fs from "node:fs";
import path from "node:path";
import type { Access } from "./access.js";
import type { Where } from "./hive-net.js";

export interface JoinedWorkspace {
  workspace: string;
  /** The host's device id. */
  host: string;
  where: Where;
  /** The role the host last gave; "owner" in a workspace of the person's, on one of their devices. */
  role: Access;
  names: { workspace: string; host: string };
  joinedAt: number;
  /** Set when this person left it, or the host removed them: what is kept here is the last copy. */
  ended?: "left" | "removed";
}

export class JoinedList {
  constructor(private readonly file: string) {}

  list(): JoinedWorkspace[] {
    try {
      const all = JSON.parse(fs.readFileSync(this.file, "utf8")) as unknown;
      return Array.isArray(all) ? all.filter((j): j is JoinedWorkspace => typeof j?.workspace === "string" && typeof j?.host === "string") : [];
    } catch {
      return [];
    }
  }

  /** Keep `joined`, in place of any earlier join of the same workspace. */
  add(joined: JoinedWorkspace): void {
    this.write([joined, ...this.list().filter((j) => j.workspace !== joined.workspace)]);
  }

  /** Change what is kept of `workspace`'s join. */
  update(workspace: string, change: Partial<Pick<JoinedWorkspace, "role" | "ended">>): void {
    this.write(this.list().map((j) => (j.workspace === workspace ? { ...j, ...change } : j)));
  }

  private write(all: JoinedWorkspace[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
