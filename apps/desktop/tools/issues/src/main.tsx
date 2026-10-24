/**
 * Issues, as a tool plugin that comes with the app: the Issues tile, with the issue dialog and New
 * issue over it, all through the plugin's `hm`. The issues themselves are the workspace's
 * (`.hivemind`), which agents and `hive` read without the app.
 */
import { useMemo, useRef, useState } from "react";
import type { TileProps, ToolModule } from "@hivemind/tile-sdk";
import { IssuesContext, useWorkflowOf, type Issues } from "./data";
import { IssuesTile } from "./IssuesTile";
import { IssuePanel } from "./IssuePanel";
import { NewIssuePanel } from "./NewIssuePanel";
import { useStartWork } from "./StartWork";
import { workPrompt } from "./IssuesTile";

type Open = { id: "issue" | "new"; params?: unknown } | null;

function Tile(props: TileProps) {
  const [open, setOpen] = useState<Open>(null);
  const { workflow, error } = useWorkflowOf(props.hm);
  // How the tile is set, as last saved: each part saved keeps the others.
  const layout = useRef((props.hm.hello.layout ?? {}) as Record<string, unknown>);
  const saveLayout = (patch: Record<string, unknown>) => { layout.current = { ...layout.current, ...patch }; props.hm.setLayout(layout.current); };
  const [quietUnassigned, setQuiet] = useState(layout.current.quietUnassigned === true);
  const start = useStartWork(props.hm, {
    frameId: props.tile.frameId,
    quietUnassigned,
    onQuietUnassigned: (q) => { setQuiet(q); saveLayout({ quietUnassigned: q }); },
    onOpenIssue: (id) => setOpen({ id: "issue", params: { id } }),
    legacyPrompt: workPrompt,
  });
  const ctx = useMemo<Issues>(() => ({
    hm: props.hm, host: props.host, frameId: props.tile.frameId, workflow, openPanel: (id, params) => setOpen({ id, params }),
    workOn: (i) => void start.workOn(i), answerFor: start.answerFor, saveLayout, layout: layout.current,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [props.hm, props.host, props.tile.frameId, workflow, quietUnassigned]);
  const close = () => setOpen(null);
  return (
    <IssuesContext.Provider value={ctx}>
      <IssuesTile {...props} workflowError={error} />
      {start.dialog}
      {open?.id === "issue" && <IssuePanel key={JSON.stringify(open.params)} {...ctx} params={open.params} close={close} />}
      {open?.id === "new" && <NewIssuePanel {...ctx} params={undefined} close={close} />}
    </IssuesContext.Provider>
  );
}

export default { tiles: { issues: Tile } } satisfies ToolModule;
