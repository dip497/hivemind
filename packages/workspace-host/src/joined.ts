/**
 * The workspaces this person joined elsewhere (M1; design §4.2 B, F): where each one's host is,
 * the role they were last given, the names to show, and whether they left or were removed, kept
 * in one private file so the app can open them again ("Recent shared"). A workspace's host can
 * change (M3: it moved to another of its owner's devices): the host it was on says where it went
 * (spec/hosting.md), and the host record its invite says where to find names the one it is on now
 * (spec/host-record.md); the later of them is kept here from then on.
 */
import fs from "node:fs";
import path from "node:path";
import type { Access } from "./access.js";
import type { Moved } from "./doc-sync.js";
import type { HiveNet, Where } from "./hive-net.js";

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
  /** Where its host record is (M3): the workspace's public key, and the lookup server its invite
   *  named (null: the one of this device's network). None: it is found where it was joined. */
  hosting?: { key: string; lookup: string | null };
  /** The moves that brought it to `host`, as the record naming it said (M3). None: never moved, as
   *  far as is known here. */
  seq?: number;
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
  update(workspace: string, change: Partial<Pick<JoinedWorkspace, "role" | "ended" | "host" | "where" | "seq">>): void {
    this.write(this.list().map((j) => (j.workspace === workspace ? { ...j, ...change } : j)));
  }

  /**
   * Where the host of the joined workspace `workspace` is now: the device its host record names,
   * as `net` reads it at the lookup server the invite named or at its own network's; a record
   * naming another device after more moves than the one it is known to be on is kept, so the next
   * dial goes there whatever the record says by then. Without a later record to read (none said,
   * no lookup server, or one that does not answer), the device it is known to be on. Null when it
   * was not joined here.
   */
  async hostOf(workspace: string, net: Pick<HiveNet, "resolveHost" | "ready">): Promise<{ host: string; where: Where } | null> {
    const joined = this.list().find((j) => j.workspace === workspace);
    if (!joined) return null;
    const lookup = joined.hosting?.lookup ?? net.ready.lookup;
    const record = joined.hosting && lookup ? await net.resolveHost(joined.hosting.key, lookup).catch(() => null) : null;
    if (!record || record.host === joined.host || record.seq <= (joined.seq ?? 0)) return { host: joined.host, where: joined.where };
    // The device is found by its id; the relay the invite named is its network's.
    const where = { addrs: [], relay: joined.where.relay };
    this.update(workspace, { host: record.host, where, seq: record.seq });
    return { host: record.host, where };
  }

  /**
   * The host of the joined workspace `workspace` says it moved (spec/hosting.md): keep the device
   * `notice` names, once the record in it, checked by `net` against the workspace's key, says the
   * same (one joined before invites carried the key follows on its host's word). Whether it is
   * followed: a notice that does not hold up changes nothing.
   */
  async follow(workspace: string, notice: Moved, net: Pick<HiveNet, "verifyHost">): Promise<boolean> {
    const joined = this.list().find((j) => j.workspace === workspace);
    if (!joined) return false;
    if (joined.hosting) {
      const said = await net.verifyHost(joined.hosting.key, notice.record).catch(() => null);
      if (said?.host !== notice.host || said.seq !== notice.seq) return false;
    }
    this.update(workspace, { host: notice.host, where: { addrs: [], relay: joined.where.relay }, seq: notice.seq });
    return true;
  }

  private write(all: JoinedWorkspace[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
