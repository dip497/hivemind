import { MISSING, type TilePlugin } from "./api";

type MissingData = { kind: string; onClose: () => void };

/** A tile whose plugin is not installed here: the board keeps it, and says what it needs. */
export const missingTile: TilePlugin<MissingData> = {
  surface: MISSING,
  name: "Missing plugin",
  kinds: {},
  data: (t, s) => ({ kind: t.kind, onClose: s.onClose }),
  body: async () => ({
    default: ({ data }) => (
      <div className="tile-drag-handle h-full w-full grid place-items-center p-6 text-center text-[12px] text-[var(--color-fg2)] bg-[var(--color-bg2)] rounded-[inherit]" data-missing-plugin={data.kind}>
        <div className="max-w-[320px] space-y-2">
          <div className="font-semibold text-[var(--color-fg)]">This tile needs a plugin that is not installed here</div>
          <div className="font-mono text-[var(--color-fg3)]">{data.kind}</div>
          <div>Install it to see the tile. The board keeps it until then.</div>
        </div>
      </div>
    ),
  }),
};
