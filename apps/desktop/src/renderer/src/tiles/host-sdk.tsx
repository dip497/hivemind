/**
 * What a tool plugin imports from the app (`hm-plugin://host/<name>.js`): the app's own React, so
 * a plugin's hooks run in the app's tree, and the parts `@hivemind/tile-sdk` names. Main serves
 * each as a module re-exporting what is put here, by the names this window reports.
 */
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import { parsePatchFiles, type CodeViewItem } from "@pierre/diffs";
import { CodeView, WorkerPoolContextProvider } from "@pierre/diffs/react";
import { TILE_API_VERSION, type HostSdk } from "@hivemind/tile-sdk";
import type { ViewClient } from "@hivemind/view-sdk";
import { Button } from "../components/ui/button";
import { Loading } from "../components/ui/loading";
import * as ui from "../plugin-ui";
import { PIERRE_OPTIONS, workerHighlighterOptions, workerPoolOptions } from "../pierre-codeview";
import type { HostModuleName } from "../../../shared/plugin-host";
import { useThemeField } from "../theme-store";

const MarkdownPreview = lazy(() => import("../markdown-preview").then((m) => ({ default: m.MarkdownPreview })));

/** A patch drawn as the app's Diff tile draws one: on the preset's page, in its syntax colours and
 *  the person's code font, its changes in the palette's ok, err and brand (pierre-codeview.ts), so a
 *  tool's diff follows the preset. */
function PatchView({ patch, className }: { patch: string; className?: string }) {
  const mode = useThemeField("mode");
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
    <WorkerPoolContextProvider poolOptions={workerPoolOptions} highlighterOptions={workerHighlighterOptions}>
      <CodeView className={className ?? "h-full w-full overflow-y-auto"} items={items}
        options={{ ...PIERRE_OPTIONS, themeType: mode, overflow: "scroll" }} />
    </WorkerPoolContextProvider>
  );
}

function Markdown({ text, className }: { text: string; className?: string }) {
  return <Suspense fallback={null}><MarkdownPreview source={text} className={className ?? "md-preview"} /></Suspense>;
}

/** A page in a frame, a server on this machine: it runs its scripts and forms, but never moves the app's window. */
function Frame({ src, title, className, style }: { src: string; title?: string; className?: string; style?: React.CSSProperties }) {
  return <iframe src={src} title={title ?? src} className={className} style={{ width: "100%", height: "100%", border: 0, ...style }}
    sandbox="allow-scripts allow-same-origin allow-forms allow-popups" />;
}

/** What each tile has saved, as it is now: its keys are written to `hm.setLayout` together. */
const saved = new WeakMap<ViewClient, Record<string, unknown>>();
function useTileState<T>(hm: ViewClient, key: string, initial: T): [T, (value: T) => void] {
  const all = () => {
    let s = saved.get(hm);
    if (!s) { s = { ...((hm.hello.layout ?? {}) as Record<string, unknown>) }; saved.set(hm, s); }
    return s;
  };
  const [value, setValue] = useState<T>(() => (Object.hasOwn(all(), key) ? all()[key] as T : initial));
  const set = useCallback((next: T) => {
    setValue(next);
    const s = all();
    s[key] = next;
    hm.setLayout(s);
  }, [hm, key]);
  return [value, set];
}

export const hostSdk: HostSdk = {
  TILE_API_VERSION,
  Button: Button as HostSdk["Button"],
  PatchView: PatchView as HostSdk["PatchView"],
  Markdown: Markdown as HostSdk["Markdown"],
  Loading: Loading as HostSdk["Loading"],
  Frame: Frame as HostSdk["Frame"],
  useTileState: useTileState as HostSdk["useTileState"],
};

const MODULES: Record<HostModuleName, object> = { react: React, "react-jsx-runtime": jsxRuntime, sdk: hostSdk, ui };

let exposed: Promise<void> | null = null;
/** Put the host modules where main's re-exports read them, once, before the first plugin loads. */
export function exposeHostModules(): Promise<void> {
  if (!exposed) {
    (globalThis as { __hiveHost?: object }).__hiveHost = MODULES;
    exposed = window.hive.toolHostExports(Object.fromEntries(Object.entries(MODULES).map(([k, m]) => [k, Object.keys(m)])));
  }
  return exposed;
}
