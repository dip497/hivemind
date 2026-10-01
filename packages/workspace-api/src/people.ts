/**
 * Who is in a workspace, as the workspace API says it (`people.*`, M3): its owner asks the
 * workspace's host, wherever the workspace is hosted.
 */
import type { LinkRole, Person } from "@hivemind/workspace-host/access";
import type { ProfileSettings } from "@hivemind/core/settings-schema";

/** Someone on a workspace's list, and whether they are connected to it now. */
export type PersonHere = Person & { present: boolean };

/** Someone asking to join a workspace, as its owner is asked about them. */
export interface JoinQuestion {
  /** What the answer names. */
  req: number;
  /** The workspace's name. */
  workspace: string;
  /** Who they say they are. */
  profile: ProfileSettings;
  /** What their link lets them do. */
  role: LinkRole;
}
