import { useEffect, useState } from "react";
import { TerminalTile } from "../TerminalTile";
import { LinkBanner } from "../machines/LinkBanner";
import { isRemote } from "@hivemind/core/remote-uri";
import { SleepingTile } from "./SleepingTile";
import type { TileBodyArgs } from "./api";
import type { TerminalTileData } from "./terminal";

/** A terminal plus its machine's link banner; asleep, a black screen with Resume. */
export default function TerminalBody({ data, selected }: TileBodyArgs<TerminalTileData>) {
  // Its exit or its open can say it sleeps before its layout does.
  const [slept, setSlept] = useState(false);
  useEffect(() => { if (data.sleeping) setSlept(false); }, [data.sleeping]);
  const { sleeping, onWake, ...terminal } = data;
  return (
    <div className="relative w-full h-full">
      {sleeping || slept
        ? <SleepingTile name={data.name} onClose={data.onClose} onWake={() => onWake().then(() => setSlept(false))} />
        : <TerminalTile {...terminal} selected={selected} onAsleep={() => setSlept(true)} />}
      {isRemote(data.cwd) && <LinkBanner cwd={data.cwd} />}
    </div>
  );
}
