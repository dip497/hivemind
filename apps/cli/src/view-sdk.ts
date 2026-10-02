/** The view SDK as `hive host` serves it to the community views it shows on the person's phone
 *  (`__sdk.js`, P8 step 3): built into a compiled `hive` by scripts/build.ts, else built from the
 *  package once it is first asked for. A browser module, minified, as the app builds its own. */
import { fileURLToPath } from "node:url";

/** Embedded by scripts/build.ts. */
declare const HIVE_VIEW_SDK_BUNDLE: string | undefined;

/** The SDK built from its sources in this checkout. */
export async function buildViewSdk(): Promise<string> {
  const entry = fileURLToPath(new URL("../../../packages/hive-view-sdk/src/index.ts", import.meta.url));
  const built = await Bun.build({ entrypoints: [entry], format: "esm", target: "browser", minify: true });
  if (!built.success) throw new AggregateError(built.logs, "the view SDK did not build");
  return built.outputs[0]!.text();
}

let building: Promise<string> | undefined;

/** The SDK this `hive` serves views. */
export function viewSdk(): Promise<string> {
  if (typeof HIVE_VIEW_SDK_BUNDLE === "string") return Promise.resolve(HIVE_VIEW_SDK_BUNDLE);
  return (building ??= buildViewSdk().catch((e: unknown) => {
    building = undefined;
    throw e;
  }));
}
