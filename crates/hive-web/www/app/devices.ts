// Devices (the Android app's DevicesScreen): the account shown, each of its computers and whether it
// is reached, the other accounts this browser is paired with to switch to, pairing another computer,
// this browser's own id, and forgetting the account, which each of its computers is told.

import type { Account } from "./accounts.js";
import { Ask, h, pill } from "./dom.js";
import type { Reach } from "./phone.js";

const KINDS: Record<string, string> = { app: "computer", host: "host" };

export interface DevicesActions {
  forget(): void;
  add(): void;
  switchTo(person: string): void;
}

export class Devices {
  readonly el = h("section", { class: "screen", "data-screen": "devices" });
  private readonly title = h("h1", { class: "title" }, "Devices");
  private readonly computers = h("div", { class: "list", "data-computers": "" });
  private readonly accounts = h("div", { class: "list", "data-accounts": "" });
  private readonly id = h("p", { class: "mono" });
  private readonly forgetting: Ask;
  private account: Account | null = null;
  private rows = new Map<string, { el: HTMLElement; status: HTMLElement; online: HTMLElement }>();

  constructor(private readonly act: DevicesActions) {
    this.forgetting = new Ask("Forget", act.forget, { "data-forget-ask": "" });
    this.el.append(
      this.title,
      this.computers,
      h("div", { class: "list" }, pill("Pair another computer", act.add, "", { "data-add-computer": "" })),
      this.accounts,
      h("div", { class: "list" },
        h("article", { class: "card device" }, h("span", { class: "label-small" }, "This browser"), this.id),
        this.forgetting.el,
        pill("Forget this account", () => this.account && this.forgetting.ask(`Forget ${this.title.dataset.whose}'s computers? Each forgets this browser. To pair again, scan the code on one.`), "danger", { "data-forget": "" })));
  }

  /** `account` shown, with `computers` as its Phone reaches them; the other `accounts` to switch to. */
  show(id: string | null, accounts: Account[], computers: Reach[], account: Account | null = null): void {
    this.id.textContent = id ?? "";
    if (id) this.id.dataset.id = id;
    this.account = account;
    this.forgetting.el.hidden = true;
    this.named(account?.name ?? null);
    this.status(computers);
    const others = accounts.filter((a) => a !== account);
    this.accounts.replaceChildren(...(others.length ? [h("span", { class: "label-small" }, "Other accounts")] : []),
      ...others.map((a) => h("article", { class: "card device", "data-account": a.person },
        h("h3", {}, a.name ?? a.computers[0]?.with.name ?? "Account"),
        h("p", { class: "status mono" }, a.computers.map((c) => c.with.name).join(", ")),
        pill("Switch", () => this.act.switchTo(a.person), "", { "data-switch": a.person }))));
  }

  /** What the person shown is called, once one of their computers says. */
  named(name: string | null): void {
    const whose = name ?? this.account?.computers[0]?.with.name ?? "your";
    this.title.dataset.whose = whose;
    this.title.textContent = name ? `${name}'s devices` : "Devices";
  }

  /** Each computer and whether it is reached. */
  status(computers: Reach[]): void {
    const seen = new Set<string>();
    const els = computers.map((c) => {
      seen.add(c.device);
      let row = this.rows.get(c.device);
      if (!row) {
        const online = h("span", { class: "online", "aria-hidden": "true" });
        const status = h("p", { class: "status mono" });
        row = { el: h("article", { class: "card device", "data-computer": c.device }), status, online };
        this.rows.set(c.device, row);
      }
      if (c.paired) row.el.dataset.paired = c.device;
      else delete row.el.dataset.paired;
      row.el.replaceChildren(
        h("span", { class: "label-small" }, KINDS[c.kind] ?? c.kind),
        h("h3", {}, row.online, c.name),
        h("p", { class: "mono" }, c.device),
        row.status);
      row.status.textContent = c.live ? "connected" : c.error ? `not reached: ${c.error}` : "connecting…";
      row.status.classList.toggle("problem", !c.live && c.error !== null);
      row.online.toggleAttribute("data-reached", c.live);
      return row.el;
    });
    for (const d of [...this.rows.keys()]) if (!seen.has(d)) this.rows.delete(d);
    this.computers.replaceChildren(...els);
  }
}
