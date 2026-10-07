/**
 * The `hive.hm` of each widget whose code runs in this window: a link per widget, as a view and a
 * tool's tile have, held to the permissions its widget.json declares, with a client for it here
 * that its worker calls by message (widget-hm.ts). Loaded once a widget with code runs.
 */
import { useContext, useEffect, useRef } from "react";
import { connect, type ViewClient } from "@hivemind/view-sdk";
import { PORT_HANDSHAKE, type ViewPermission } from "@hivemind/view-sdk/protocol";
import type { WidgetPackage } from "../../../shared/ipc";
import { usePluginLink } from "../workspace/plugin-link";
import { WorkspacePropsContext } from "../workspace/workspace-props";
import type { WorkspaceViewProps } from "../workspace/workspace-view";
import { bridgeClient } from "./widget-hm";
import { postToWidget, setWidgetBridge, useRunningWidgets } from "./widget-runtime";

export function WidgetLinks() {
  const props = useContext(WorkspacePropsContext);
  const running = useRunningWidgets();
  if (!props) return null;
  return <>{running.map((r) => <WidgetLink key={r.id} id={r.id} pkg={r.pkg} props={props} />)}</>;
}

function WidgetLink({ id, pkg, props }: { id: string; pkg: WidgetPackage; props: WorkspaceViewProps }) {
  const root = useRef<HTMLElement | null>(null);
  const { link, dialogs } = usePluginLink({
    pluginId: pkg.id, record: { kind: "widget", id: pkg.id }, name: pkg.name,
    capabilities: pkg.permissions as ViewPermission[], fields: [], layoutId: `widget:${id}`,
    props, root, onDisable: (reason) => console.warn(`[widget ${pkg.id}] its hive.hm stopped: ${reason}`),
  });
  useEffect(() => {
    const ch = new MessageChannel();
    link.attach(ch.port1);
    const target = new EventTarget();
    let live = true;
    let off = () => {};
    void connect({ target: target as unknown as Window, timeoutMs: 10_000 }).then((client: ViewClient) => {
      if (!live) return;
      const bridge = bridgeClient(client, (m) => postToWidget(id, m));
      setWidgetBridge(id, bridge);
      const stop = client.on("settings", () => bridge.refresh());
      off = () => { stop(); bridge.dispose(); setWidgetBridge(id, null); };
    }, (e: Error) => console.warn(`[widget ${pkg.id}] ${e.message}`));
    target.dispatchEvent(new MessageEvent("message", { data: { type: PORT_HANDSHAKE }, ports: [ch.port2] }));
    return () => { live = false; off(); };
  }, [link, id, pkg.id]);
  return <>{dialogs}</>;
}
