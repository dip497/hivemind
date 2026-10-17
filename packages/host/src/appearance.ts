/**
 * How a host looks, as its guests show its workspaces (the workspace API's `appearance.get`,
 * `appearance.changed`): its theme, with nothing that names a file on its disk. Every client is
 * told when what a guest would see changes, so a host recolouring itself recolours its guests.
 * Electron-free.
 */
import { sharedAppearance, type Appearance } from "@hivemind/core/settings-schema";
import type { Domain, WorkspaceServer } from "@hivemind/workspace-api/server";

export interface AppearanceOptions {
  /** The host's own appearance now. */
  current(): Appearance;
  /** Call `listener` with the host's appearance whenever its settings change. */
  onChange(listener: (appearance: Appearance) => void): void;
  server(): WorkspaceServer;
}

export function appearance(o: AppearanceOptions): Domain<"appearance.get"> {
  let told = JSON.stringify(sharedAppearance(o.current()));
  o.onChange((a) => {
    const shared = sharedAppearance(a);
    const json = JSON.stringify(shared);
    // A change a guest does not see (a font, a picture wallpaper swapped for another) is not news.
    if (json === told) return;
    told = json;
    o.server().publish("appearance.changed", shared);
  });
  return {
    answers: { "appearance.get": () => sharedAppearance(o.current()) },
    effects: {},
  };
}
