/**
 * Saying which device hosts the workspaces shared from here (M3, design §5.8,
 * spec/host-record.md). On a network with a lookup server, each one has a host record there,
 * signed by the workspace's key, naming this device: said when the network starts, when a
 * workspace is shared, and every hour after, since the server forgets a record not said again for
 * a week. Someone with an invite finds the host by it, wherever the host is now.
 *
 * A record counts the moves that brought the workspace where it is: one not said yet is said with
 * 1, one naming this device is said again as it is, and one naming another device is that
 * device's to say (the workspace moved there) and is left alone.
 */
import type { HiveNet } from "./hive-net.js";

/** A workspace this device hosts: its id, and its public key (what its record is filed under). */
export interface Hosted {
  workspace: string;
  key: string;
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

  /** Say `ws`'s record, unless another device's names it. */
  private async say(ws: Hosted): Promise<void> {
    const { net } = this.o;
    const now = await net.resolveHost(ws.key);
    if (now && now.host !== net.ready.id) {
      this.o.onWarn?.(`workspace ${ws.workspace.slice(0, 8)}… is hosted by ${now.host.slice(0, 8)}… now`);
      return;
    }
    await net.publishHost(ws.workspace, now?.seq ?? 1);
  }
}
