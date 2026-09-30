/**
 * Who is in a workspace now, and where (M1; design §4.2 C, §4.3): each participant's state as they
 * last sent it (their name and colour, their pointer on the board, what they have selected), one
 * participant per client connection. It is never stored: a participant is gone when their
 * connection goes, or when they have said nothing for a while.
 */

/** Where a participant is on the board. */
export interface PresenceState {
  name: string;
  color: string;
  /** Their pointer, in board coordinates; null when it is off the board. */
  cursor: { x: number; y: number } | null;
  /** The tiles and objects they have selected. */
  selection: string[];
}

export interface Participant extends PresenceState {
  /** Their connection's id: one per window, or per peer device. */
  id: string;
  /** Their person key. */
  person: string;
}

/** A participant who has said nothing for this long is gone. */
export const QUIET_FOR_MS = 60_000;

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A state from anything a client sent: bounded and checked, or null. */
export function presenceOf(raw: unknown): PresenceState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const cursor = r.cursor as Record<string, unknown> | null | undefined;
  return {
    name: typeof r.name === "string" ? r.name.slice(0, 64) : "",
    color: typeof r.color === "string" && /^#[0-9a-f]{6}$/i.test(r.color) ? r.color.toLowerCase() : "",
    cursor: cursor && num(cursor.x) && num(cursor.y) ? { x: cursor.x, y: cursor.y } : null,
    selection: Array.isArray(r.selection) ? r.selection.filter((s): s is string => typeof s === "string").slice(0, 100) : [],
  };
}

export class PresenceHub {
  private readonly workspaces = new Map<string, Map<string, Participant & { at: number }>>();

  /** `participant` is in `repo` as `state` now. Returns who is there. */
  set(repo: string, participant: Participant): Participant[] {
    let here = this.workspaces.get(repo);
    if (!here) this.workspaces.set(repo, (here = new Map()));
    here.set(participant.id, { ...participant, at: Date.now() });
    return this.people(repo);
  }

  /** `id` left `repo`, or every workspace when none is named. Returns the workspaces it was in. */
  leave(id: string, repo?: string): string[] {
    const left: string[] = [];
    for (const [r, here] of this.workspaces) if ((repo === undefined || r === repo) && here.delete(id)) left.push(r);
    return left;
  }

  /** Who is in `repo` now: those who spoke within `QUIET_FOR_MS`. */
  people(repo: string): Participant[] {
    const here = this.workspaces.get(repo);
    if (!here) return [];
    const now = Date.now();
    const out: Participant[] = [];
    for (const [id, p] of here) {
      if (now - p.at > QUIET_FOR_MS) here.delete(id);
      else out.push({ id: p.id, person: p.person, name: p.name, color: p.color, cursor: p.cursor, selection: p.selection });
    }
    return out;
  }
}
