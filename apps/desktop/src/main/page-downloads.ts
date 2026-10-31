/**
 * Downloads from Browser tiles' pages, which Electron would otherwise ask about with a Save dialog
 * nothing can answer for an agent. A download goes to the Downloads folder, under a name nothing
 * there has, and the tile says so. One an agent started goes where the agent asked (DevTools'
 * `Browser.setDownloadBehavior`, which Chromium would apply to another session), and it hears how
 * it goes, as DevTools tells it.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DownloadItem, Session, WebContents } from "electron";
import type { PageDownload } from "../shared/ipc.js";

/** An agent's request lasts while it is at work: a person's own download later, in a page the
 *  agent still holds, is the person's. */
const AGENT_AT_WORK_MS = 10_000;
/** Saved downloads a tile can still show in their folder. */
const REMEMBERED = 50;

/** One agent connection's say over the downloads of the pages it holds. */
export class AgentDownloads {
  private behavior = "default";
  private folder = "";
  private hears = false;
  private lastHeardFrom = 0;

  constructor(
    readonly holds: (page: WebContents) => boolean,
    readonly tell: (event: { method: string; params: Record<string, unknown> }) => void,
    readonly stop: () => void,
  ) {}

  /** DevTools' `Browser.setDownloadBehavior`. */
  ask(params: Record<string, unknown>): void {
    const { behavior, downloadPath, eventsEnabled } = params;
    if (typeof behavior !== "string" || !["default", "deny", "allow", "allowAndName"].includes(behavior)) throw new Error("behavior is default, deny, allow or allowAndName");
    const saves = behavior === "allow" || behavior === "allowAndName";
    if (saves && (typeof downloadPath !== "string" || !path.isAbsolute(downloadPath))) throw new Error("downloadPath must be a full path");
    this.behavior = behavior;
    this.folder = saves ? (downloadPath as string) : "";
    this.hears = eventsEnabled === true;
  }

  /** The agent just sent something. */
  heardFrom(): void { this.lastHeardFrom = Date.now(); }

  get listening(): boolean { return this.hears; }

  /** What it wants done with a download starting now; null: it has no say. */
  get wants(): { behavior: string; folder: string } | null {
    if (this.behavior === "default" || Date.now() - this.lastHeardFrom > AGENT_AT_WORK_MS) return null;
    return { behavior: this.behavior, folder: this.folder };
  }
}

export class PageDownloads {
  private readonly agents = new Set<AgentDownloads>();
  /** Paths downloads in progress will take: not on disk under that name until they finish. */
  private readonly saving = new Set<string>();
  private readonly saved = new Map<string, string>();

  constructor(
    private readonly downloadsFolder: () => string,
    /** The DevTools target of `page`, once known: a page an agent holds always has it. */
    private readonly targetOf: (page: WebContents) => string | undefined,
    private readonly tellTile: (page: WebContents, download: PageDownload) => void,
  ) {}

  watch(session: Session): void {
    session.on("will-download", (_e, item, page) => this.started(item, page));
  }

  /** An agent's connection, until it calls `stop`. */
  follow(holds: (page: WebContents) => boolean, tell: AgentDownloads["tell"]): AgentDownloads {
    const agent = new AgentDownloads(holds, tell, () => this.agents.delete(agent));
    this.agents.add(agent);
    return agent;
  }

  /** Where a download the tile named was saved. */
  pathOf(id: string): string | undefined {
    return this.saved.get(id);
  }

  /** `name` in `folder`, or with a number when that is taken: `report.pdf`, `report (1).pdf`. */
  private freePath(folder: string, name: string): string {
    const { name: stem, ext } = path.parse(name);
    for (let n = 0; ; n++) {
      const candidate = path.join(folder, n ? `${stem} (${n})${ext}` : name);
      if (!this.saving.has(candidate) && !fs.existsSync(candidate)) return candidate;
    }
  }

  private started(item: DownloadItem, page: WebContents): void {
    const id = randomUUID();
    const name = path.basename(item.getFilename()) || "download";
    const followers = [...this.agents].filter((a) => a.holds(page));
    const wanted = followers.map((a) => a.wants).find((w) => w !== null) ?? null;
    const listeners = followers.filter((a) => a.listening);
    const event = (method: string, params: Record<string, unknown>) => { for (const a of listeners) a.tell({ method, params }); };
    event("Browser.downloadWillBegin", { frameId: this.targetOf(page) ?? "", guid: id, url: item.getURL(), suggestedFilename: name });
    const progress = (state: string, filePath?: string) => event("Browser.downloadProgress", { guid: id, totalBytes: item.getTotalBytes(), receivedBytes: item.getReceivedBytes(), state, ...(filePath ? { filePath } : {}) });

    const folder = wanted?.folder || this.downloadsFolder();
    let savePath: string | null = null;
    if (wanted?.behavior !== "deny") {
      try {
        fs.mkdirSync(folder, { recursive: true });
        savePath = wanted?.behavior === "allowAndName" ? path.join(folder, id) : this.freePath(folder, name);
      } catch { /* a folder that cannot be made fails the download, below */ }
    }
    // Said on the tile whoever it is for: an agent's window can catch a person's click.
    const say = (state: PageDownload["state"]) => {
      if (!page.isDestroyed()) this.tellTile(page, { pageId: page.id, id, name: savePath && !wanted ? path.basename(savePath) : name, state, ...(wanted ? { forAgent: true } : {}) });
    };
    if (savePath === null) {
      item.cancel();
      progress("canceled");
      say("failed");
      return;
    }
    const to = savePath;
    item.setSavePath(to);
    this.saving.add(to);
    say("saving");
    item.on("updated", () => progress("inProgress"));
    item.once("done", (_e, state) => {
      this.saving.delete(to);
      const completed = state === "completed";
      progress(completed ? "completed" : "canceled", completed ? to : undefined);
      if (completed) {
        this.saved.set(id, to);
        if (this.saved.size > REMEMBERED) this.saved.delete(this.saved.keys().next().value as string);
      }
      say(completed ? "saved" : "failed");
    });
  }
}
