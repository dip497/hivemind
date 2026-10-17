/**
 * Saying which device hosts the workspaces shared from here (M3, design §5.8,
 * spec/host-record.md). On a network with a lookup server, each one has a host record there,
 * signed by the workspace's key, naming this device: said when the network starts, when a
 * workspace is shared, and every hour after, since the server forgets a record not said again for
 * a week. Someone with an invite finds the host by it, wherever the host is now.
 *
 * A record counts the moves that brought the workspace where it is: one not said yet is said with
 * the count this device knows (1, for a workspace never moved), one naming this device is said
 * again as it is, and one naming another device is that device's to say, unless this device
 * knows of a later move (it took the workspace from that device). One naming another device after
 * more moves than this one knows of, or as many by a device whose id is lower (two took it over
 * at once), says the workspace is that device's now, taken over while this one was away: the
 * embedder hears of it (`elsewhere`).
 */
import type { FoundHost, HiveNet } from "./hive-net.js";

/** A workspace this device hosts: its id, its public key (what its record is filed under), and the
 *  moves that brought it here, as its access list says (none: never moved). */
export interface Hosted {
  workspace: string;
  key: string;
  seq?: number;
}

/** How often each record is said again: the lookup server forgets one after a week. */
export const SAY_AGAIN_MS = 60 * 60_000;

export class HostRecords {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly o: {
    /** This device's daemon, running. */
    net: HiveNet;
    /** The workspaces this device hosts, shared with someone. */
    hosted(): Hosted[];
    /** `workspace`, hosted here as far as this device knew, is hosted by another device now, as
     *  `found` says (spec/hosting.md). */
    elsewhere?(workspace: string, found: FoundHost): void;
    onWarn?(message: string): void;
  }) {}

  /** Say every record now, and again every hour until stopped. Resolves once each has been said
   *  this first time. */
  start(): Promise<void> {
    this.stop();
    this.timer = setInterval(() => void this.sayAll(), SAY_AGAIN_MS);
    this.timer.unref?.();
    return this.sayAll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async sayAll(): Promise<void> {
    // On a network without a lookup server there is nowhere to say them, and nobody looks there.
    if (!this.o.net.ready.lookup) return;
    for (const ws of this.o.hosted()) {
      try {
        await this.say(ws);
      } catch (e) {
        this.o.onWarn?.(`could not say where workspace ${ws.workspace.slice(0, 8)}… is: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** Say `ws`'s record, unless another device's names it after more moves, or as many by a device
   *  whose id is lower: the workspace is that device's now. */
  private async say(ws: Hosted): Promise<void> {
    const { net } = this.o;
    const mine = ws.seq ?? 1;
    const now = await net.resolveHost(ws.key);
    if (now && now.host !== net.ready.id && (now.seq > mine || (now.seq === mine && now.host < net.ready.id))) {
      this.o.onWarn?.(`workspace ${ws.workspace.slice(0, 8)}… is hosted by ${now.host.slice(0, 8)}… now`);
      this.o.elsewhere?.(ws.workspace, now);
      return;
    }
    await net.publishHost(ws.workspace, Math.max(mine, now?.host === net.ready.id ? now.seq : 0));
  }
}
