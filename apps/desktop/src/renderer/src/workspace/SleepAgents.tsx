import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { Skipped } from "@hivemind/workspace-api/agents";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../components/ui/dialog";
import { Button } from "../components/ui/button";
import { putToSleep } from "./sleep-agents";

/** Putting agents to sleep and waking them: a tile, a frame (and the frames in it), or with no
 *  target every agent in the workspace. */
export interface SleepActions {
  sleep: (target?: string) => Promise<void>;
  wake: (target?: string) => Promise<void>;
}

/** A tile as these need it: what it is called, whether it is an agent, and whether it sleeps. */
export interface SleepingTileFacts { name: string; agent: boolean; sleeping: boolean }

/** Sleep and wake for the workspace at `repo`, telling what was left as it was, and the dialog that
 *  asks before an agent mid-turn or waiting on someone is put to sleep. */
export function useSleepAgents(repo: string | null, tileOf: (id: string) => SleepingTileFacts | undefined): { actions: SleepActions; dialog: ReactNode } {
  const [ask, setAsk] = useState<{ names: string[]; answer: (yes: boolean) => void } | null>(null);
  const tileOfRef = useRef(tileOf);
  tileOfRef.current = tileOf;

  const actions = useMemo<SleepActions>(() => {
    // A tile named is told about whatever its answer; a frame's or the workspace's, only its agents
    // that were not already as asked.
    const worthTelling = (target: string | undefined, sleeping: boolean) => (s: Skipped) => {
      const t = tileOfRef.current(s.tile);
      return s.tile === target || (!!t?.agent && t.sleeping === sleeping);
    };
    const tell = (what: string, skipped: Skipped[]) => {
      if (!skipped.length) return;
      const nameOf = (s: Skipped) => tileOfRef.current(s.tile)?.name ?? s.tile;
      if (skipped.length === 1) return void toast(`${nameOf(skipped[0]!)} ${what}`, { description: skipped[0]!.why });
      toast(`${skipped.length} agents ${what}`, { description: <div>{skipped.map((s) => <div key={s.tile}>{nameOf(s)}: {s.why}</div>)}</div> });
    };
    const failed = (what: string) => (e: unknown) => toast.error(`${what}: ${e instanceof Error ? e.message : String(e)}`);
    const confirm = (busy: string[]) => new Promise<boolean>((answer) =>
      setAsk({ names: busy.map((id) => tileOfRef.current(id)?.name ?? id), answer: (yes) => { setAsk(null); answer(yes); } }));
    return {
      sleep: async (target) => {
        if (!repo) return;
        await putToSleep(repo, target, confirm)
          .then(({ skipped }) => tell("not put to sleep", skipped.filter(worthTelling(target, false))), failed("Not put to sleep"));
      },
      wake: async (target) => {
        if (!repo) return;
        await window.hive.agentWake(repo, target)
          .then(({ skipped }) => tell("not resumed", skipped.filter(worthTelling(target, true))), failed("Not resumed"));
      },
    };
  }, [repo]);

  const answer = useCallback((yes: boolean) => ask?.answer(yes), [ask]);
  const one = ask?.names.length === 1;
  const dialog = (
    <Dialog open={!!ask} onOpenChange={(open) => { if (!open) answer(false); }}>
      <DialogContent className="sm:max-w-[420px]" data-sleep-busy>
        <DialogTitle>{one ? `Put ${ask?.names[0]} to sleep?` : `Put ${ask?.names.length ?? 0} busy agents to sleep?`}</DialogTitle>
        <DialogDescription>
          {one ? "It is working or waiting on someone, and what it is doing stops." : `${ask?.names.join(", ")} are working or waiting on someone, and what they are doing stops.`}
          {" "}Resume continues the conversation.
        </DialogDescription>
        <DialogFooter>
          <Button variant="ghost" autoFocus onClick={() => answer(false)} data-sleep-busy-keep>Keep awake</Button>
          <Button onClick={() => answer(true)} data-sleep-busy-confirm>Put to sleep</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
  return { actions, dialog };
}
