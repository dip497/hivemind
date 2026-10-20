/** The SDK sources a starter gets as its types, from the same packages the app is built from:
 *  embedded by scripts/build.ts, read from the checkout when run from source. Editing them in a
 *  plugin changes nothing at run time. */
import { readFileSync } from "node:fs";

/** Each package a plugin is given the types of, its folder in this repository, and its files. */
export const TYPE_PACKAGES = {
  "view-sdk": { dir: "packages/hive-view-sdk/src", files: ["index.ts", "protocol.ts", "manifest.ts", "settings.ts", "category.ts", "commands.ts", "client.ts", "testing.ts"] },
  "tile-sdk": { dir: "packages/tile-sdk/src", files: ["index.ts"] },
} as const;
export type TypePackage = keyof typeof TYPE_PACKAGES;

declare const HIVE_TYPE_FILES: Record<string, string> | undefined;

/** `<package>/<file>` → its text. */
export function typeSources(): Record<string, string> {
  if (typeof HIVE_TYPE_FILES === "object") return HIVE_TYPE_FILES;
  return Object.fromEntries(Object.entries(TYPE_PACKAGES).flatMap(([pkg, { dir, files }]) =>
    files.map((f) => [`${pkg}/${f}`, readFileSync(new URL(`../../../${dir}/${f}`, import.meta.url), "utf8")])));
}

const NOTE = "// The SDK Hivemind gives your plugin, here for its types. Editing it changes nothing at run time.\n";

/** The files of `packages` as a starter writes them, under `types/`. */
export function typeFiles(packages: readonly TypePackage[]): Record<string, string> {
  const all = typeSources();
  return Object.fromEntries(Object.entries(all).filter(([f]) => packages.some((p) => f.startsWith(`${p}/`))).map(([f, text]) => [`types/${f}`, NOTE + text]));
}

/** The declaration `export interface|type <name>` in `text`, whole, with its doc comment. */
export function declaration(text: string, name: string): string | null {
  const at = new RegExp(`^export (interface|type) ${name}\\b`, "m").exec(text);
  if (!at) return null;
  const doc = /\/\*\*(?:(?!\*\/)[\s\S])*\*\/\n$/.exec(text.slice(0, at.index));
  // An interface ends with its closing brace; a type with the first `;` outside any brace.
  let depth = 0, i = at.index;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0 && at[1] === "interface") break;
    else if (c === ";" && depth === 0 && at[1] === "type") break;
  }
  return (doc?.[0] ?? "") + text.slice(at.index, i + 1);
}
