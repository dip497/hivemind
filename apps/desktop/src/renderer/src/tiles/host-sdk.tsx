/**
 * What a tool plugin imports from the app (`hm-plugin://host/<name>.js`): the app's own React, so
 * a plugin's hooks run in the app's tree, and the parts `@hivemind/tile-sdk` names. Main serves
 * each as a module re-exporting what is put here, by the names this window reports.
 */
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { lazy, Suspense, useMemo } from "react";
import { parsePatchFiles, type CodeViewItem } from "@pierre/diffs";
import { CodeView } from "@pierre/diffs/react";
import { TILE_API_VERSION, type HostSdk } from "@hivemind/tile-sdk";
import { Button } from "../components/ui/button";

const MarkdownPreview = lazy(() => import("../markdown-preview").then((m) => ({ default: m.MarkdownPreview })));

function PatchView({ patch, className }: { patch: string; className?: string }) {
  const items = useMemo(() => {
    const out: CodeViewItem<undefined>[] = [];
    if (!patch.trim()) return out;
    for (const parsed of parsePatchFiles(patch)) {
      for (const fileDiff of parsed.files) out.push({ id: `diff:${fileDiff.name}`, type: "diff", fileDiff });
    }
    return out;
  }, [patch]);
  if (!items.length) return <div className={className}>No changes.</div>;
  return (
    <CodeView className={className ?? "h-full w-full overflow-y-auto"} items={items}
      options={{ theme: { dark: "pierre-dark", light: "pierre-light" }, themeType: "dark", overflow: "scroll" }} />
  );
}

function Markdown({ text, className }: { text: string; className?: string }) {
  return <Suspense fallback={null}><MarkdownPreview source={text} className={className ?? "md-preview"} /></Suspense>;
}

export const hostSdk: HostSdk = {
  TILE_API_VERSION,
  Button: Button as HostSdk["Button"],
  PatchView: PatchView as HostSdk["PatchView"],
  Markdown: Markdown as HostSdk["Markdown"],
};

const MODULES: Record<string, object> = { react: React, "react-jsx-runtime": jsxRuntime, sdk: hostSdk };

let exposed: Promise<void> | null = null;
/** Put the host modules where main's re-exports read them, once, before the first plugin loads. */
export function exposeHostModules(): Promise<void> {
  if (!exposed) {
    (globalThis as { __hiveHost?: object }).__hiveHost = MODULES;
    exposed = window.hive.toolHostExports(Object.fromEntries(Object.entries(MODULES).map(([k, m]) => [k, Object.keys(m)])));
  }
  return exposed;
}
