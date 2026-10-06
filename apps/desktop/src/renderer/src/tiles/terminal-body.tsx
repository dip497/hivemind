import { TerminalTile } from "../TerminalTile";
import { LinkBanner } from "../machines/LinkBanner";
import { isRemote } from "@hivemind/core/remote-uri";
import type { TileBodyArgs } from "./api";
import type { TerminalTileData } from "./terminal";

/** A terminal plus its machine's link banner. */
export default function TerminalBody({ data, selected }: TileBodyArgs<TerminalTileData>) {
  return (
    <div className="relative w-full h-full">
      <TerminalTile {...data} selected={selected} />
      {isRemote(data.cwd) && <LinkBanner cwd={data.cwd} />}
    </div>
  );
}
