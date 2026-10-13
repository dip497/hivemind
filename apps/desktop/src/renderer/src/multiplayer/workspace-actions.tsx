/**
 * Who is in the workspace a window shows, and what its owner may do about them (top right): their
 * faces, and for the workspace's owner, Settings → People. Share sits in the tool island. The owner is the person here
 * for a workspace of this machine's, and for one of theirs hosted on another of their devices,
 * which its host answers (M3); someone else's, joined from elsewhere, is its owner's to share.
 */
import { PeopleHere } from "./presence";
import { joinedId, useShown } from "./shown";

/** The workspace a window shows is this person's to share. */
export function useCanShare(): boolean {
  const { repo, shared } = useShown();
  return !!repo && (!joinedId(repo) || shared?.access === "owner");
}

export function WorkspaceActions({ onPeople }: { onPeople: () => void }) {
  const { repo } = useShown();
  const owner = useCanShare();
  if (!repo) return null;
  return <PeopleHere repo={repo} onManage={owner ? onPeople : undefined} follow={!owner} />;
}
