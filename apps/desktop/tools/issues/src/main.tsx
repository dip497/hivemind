/**
 * Issues, as a tool plugin that comes with the app: the Issues tile, with the issue dialog and New
 * issue over it, all through the plugin's `hm`. The issues themselves are the workspace's
 * (`.hivemind`), which agents and `hive` read without the app.
 */
import { useMemo, useState } from "react";
import type { TileProps, ToolModule } from "@hivemind/tile-sdk";
import { IssuesContext, useWorkflowOf, type Issues } from "./data";
import { IssuesTile } from "./IssuesTile";
import { IssuePanel } from "./IssuePanel";
import { NewIssuePanel } from "./NewIssuePanel";

type Open = { id: "issue" | "new"; params?: unknown } | null;

function Tile(props: TileProps) {
  const [open, setOpen] = useState<Open>(null);
  const { workflow, error } = useWorkflowOf(props.hm);
  const ctx = useMemo<Issues>(
    () => ({ hm: props.hm, host: props.host, frameId: props.tile.frameId, workflow, openPanel: (id, params) => setOpen({ id, params }) }),
    [props.hm, props.host, props.tile.frameId, workflow],
  );
  const close = () => setOpen(null);
  return (
    <IssuesContext.Provider value={ctx}>
      <IssuesTile {...props} workflowError={error} />
      {open?.id === "issue" && <IssuePanel key={JSON.stringify(open.params)} {...ctx} params={open.params} close={close} />}
      {open?.id === "new" && <NewIssuePanel {...ctx} params={undefined} close={close} />}
    </IssuesContext.Provider>
  );
}

export default { tiles: { issues: Tile } } satisfies ToolModule;
