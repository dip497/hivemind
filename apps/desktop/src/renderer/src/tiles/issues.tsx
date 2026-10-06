import { ListTodo } from "lucide-react";
import type { TilePlugin, PinRect } from "./api";

export type IssuesTileData = {
  root: string | null;
  onClose: () => void;
  pinned?: boolean;
  onTogglePin?: (id: string, rect: PinRect) => void;
};

/** The workspace's issue board. */
export const issuesTile: TilePlugin<IssuesTileData> = {
  surface: "issues",
  name: "Issues",
  kinds: { issues: { size: { width: 680, height: 460 }, label: "Issues", singleton: true, title: "Issues", icon: ListTodo, glyph: "◔" } },
  data: (_t, s) => ({ root: s.root, onClose: s.onClose, ...s.pin }),
  body: () => import("../IssuesTile").then((m) => ({ default: ({ data, selected }) => <m.IssuesTile {...data} selected={selected} /> })),
};
