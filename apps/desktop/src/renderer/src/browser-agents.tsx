/**
 * Which agents may drive a Browser tile, and who is driving it now. The tile keeps the person's own
 * pages to themselves: by default only the agents in its frame reach it.
 */
import { useEffect, useState } from "react";
import { Bot } from "./components/icons";
import { Button } from "./components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import { useSettings } from "./settings-store";
import { SiteName } from "./browser-asks";
import type { BrowserPersonAsk } from "../../shared/ipc";
import type { AgentAccess } from "@hivemind/core/settings-schema";

const setAccess = (tileId: string, tiles: Record<string, AgentAccess>, to: AgentAccess) => {
  const { [tileId]: _was, ...others } = tiles;
  return window.hive.settingsSet("agentBrowser.tiles", to === "frame" ? others : { ...others, [tileId]: to });
};

/** The tile's choice of who may drive it. */
export function AgentAccessMenu({ tileId }: { tileId: string }) {
  const { agentBrowser } = useSettings();
  const access = agentBrowser.tiles[tileId] ?? "frame";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-2xs" className="nodrag" aria-label="agents" title="Which agents can use this tile" data-agent-access={access}>
          <Bot className={access === "none" ? "opacity-40" : undefined} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Agents that can use this tile</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={access} onValueChange={(to) => void setAccess(tileId, agentBrowser.tiles, to as AgentAccess)}>
          <DropdownMenuRadioItem value="frame">Agents in this frame</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="all">Every agent</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="none">No agents</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Says who is changing the page while they are, with a way to stop them. */
export function DrivingBar({ tileId }: { tileId: string }) {
  const { agentBrowser } = useSettings();
  const [driver, setDriver] = useState<{ by: string | null } | null>(null);
  useEffect(() => window.hive.onBrowserDriving((e) => {
    if (e.tileId === tileId) setDriver(e.driving ? { by: e.by } : null);
  }), [tileId]);
  if (!driver) return null;
  return (
    <div data-agent-driving className="pointer-events-auto flex h-7 items-center gap-2 border-b border-[var(--color-line)] bg-[var(--color-bg4)] px-2 text-chip text-[var(--color-fg2)]">
      <Bot size={12} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">{driver.by ?? "An agent"} is using this page</span>
      <Button variant="ghost" size="xs" className="nodrag" onClick={() => { setDriver(null); void setAccess(tileId, agentBrowser.tiles, "none"); }}>Stop</Button>
    </div>
  );
}

/** How long a question is on screen before its buttons take a click: a click meant for the page,
 *  landing where it has just appeared, answers nothing. */
const ARMED_AFTER_MS = 500;

/** What an agent asks the person on this tile, over the top of the page, which stays usable. */
export function PersonAskBar({ tileId }: { tileId: string }) {
  const [asks, setAsks] = useState<BrowserPersonAsk[]>([]);
  useEffect(() => {
    let live = true;
    void window.hive.browserAsks().then((list) => { if (live) setAsks(list.filter((a) => a.tile === tileId)); }, () => {});
    const off = window.hive.onBrowserPersonAsk((e) => {
      if (e.tile !== tileId) return;
      setAsks((list) => ("ended" in e ? list.filter((a) => a.ask !== e.ask) : [...list.filter((a) => a.ask !== e.ask), e]));
    });
    return () => { live = false; off(); };
  }, [tileId]);
  const ask = asks[0];
  const [armed, setArmed] = useState<number | null>(null);
  useEffect(() => {
    if (!ask) return;
    const timer = setTimeout(() => setArmed(ask.ask), ARMED_AFTER_MS);
    return () => clearTimeout(timer);
  }, [ask?.ask]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!ask) return null;
  const ready = armed === ask.ask;
  const answer = (to: "yes" | "always" | "no" | "done") => void window.hive.browserAnswerAsk(ask.ask, to);
  const who = ask.by ?? "An agent";
  return (
    <div role="alertdialog" aria-label={`${who} asks`} data-person-ask={ask.kind} className="pointer-events-auto absolute inset-x-0 top-0 z-10 flex flex-wrap items-center gap-2 px-2 py-1 bg-[var(--color-bg4)] border-b border-[var(--color-line)] shadow-[var(--hm-shadow-float)] text-label text-[var(--color-fg)]">
      {ask.kind === "sign-in" ? (
        <>
          <p className="m-0 flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1">
            <span>{who} wants to sign in to</span>
            <SiteName site={ask.site} />
            <span>as <b>{ask.username}</b>. It won't see the password.</span>
          </p>
          <Button variant="ghost" size="xs" className="nodrag" disabled={!ready} onClick={() => answer("no")}>No</Button>
          <Button variant="ghost" size="xs" className="nodrag" disabled={!ready} onClick={() => answer("always")}>Always on this site</Button>
          <Button variant="secondary" size="xs" className="nodrag" disabled={!ready} onClick={() => answer("yes")}>Sign in once</Button>
        </>
      ) : (
        <>
          <p className="m-0 min-w-0 flex-1"><b>{who}:</b> {ask.words} It can't see this page until you're done.</p>
          <Button variant="ghost" size="xs" className="nodrag" disabled={!ready} onClick={() => answer("no")}>Not now</Button>
          <Button variant="secondary" size="xs" className="nodrag" disabled={!ready} onClick={() => answer("done")}>Done</Button>
        </>
      )}
    </div>
  );
}
