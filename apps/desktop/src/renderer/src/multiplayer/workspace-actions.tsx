/**
 * Who is in the workspace a window shows, and what its owner may do about them (top right): their
 * faces, and for the workspace's owner, the People panel and Share. The owner is the person here
 * for a workspace of this machine's, and for one of theirs hosted on another of their devices,
 * which its host answers (M3); someone else's, joined from elsewhere, is its owner's to share.
 */
import { Share2 } from "lucide-react";
import { Button } from "../components/ui/button";
import { PeopleHere } from "./presence";
import { joinedId, useShown } from "./shown";

export function WorkspaceActions({ onShare, onPeople }: { onShare: () => void; onPeople: () => void }) {
  const { repo, shared } = useShown();
  if (!repo) return null;
  const owner = !joinedId(repo) || shared?.access === "owner";
  return (
    <>
      <PeopleHere repo={repo} onManage={owner ? onPeople : undefined} hostName={owner ? undefined : shared?.names.host} />
      {owner && (
        <Button
          variant="secondary"
          size="sm"
          onClick={onShare}
          className="pointer-events-auto"
          title="Invite people to this workspace"
          data-share
        >
          <Share2 aria-hidden />
          <span>Share</span>
        </Button>
      )}
    </>
  );
}
