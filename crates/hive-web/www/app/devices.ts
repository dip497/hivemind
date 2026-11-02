// Devices (the Android app's DevicesScreen): the account shown, each of its computers and whether it
// is reached, the other accounts this browser is paired with to switch to, pairing another computer,
// this browser's own id, and forgetting the account, which each of its computers is told.

import type { Account } from "./accounts.js";
import { Ask, h, pill } from "./dom.js";
import type { Reach } from "./phone.js";

const KINDS: Record<string, string> = { app: "Computer", host: "Host" };

/** A device id, too long to read at a glance: on one line till it is tapped. */
function idLine(): HTMLButtonElement {
  const line = h("button", { type: "button", class: "device-id mono", "aria-expanded": "false" });
  line.addEventListener("click", () => line.setAttribute("aria-expanded", String(line.getAttribute("aria-expanded") !== "true")));
  return line;
}

export interface DevicesActions {
  forget(): void;
  add(): void;
  switchTo(person: string): void;
}

export class Devices {
  readonly el = h("section", { class: "screen", "data-screen": "devices" });
  private readonly title = h("h1", { class: "title" }, "Devices");
  private readonly computers = h("div", { class: "list", "data-computers": "" });
  private readonly accounts = h("div", { "data-accounts": "" });
  private readonly id = idLine();
  private readonly forgetting: Ask;
  private account: Account | null = null;
  private rows = new Map<string, { el: HTMLElement; status: HTMLElement; online: HTMLElement; id: HTMLButtonElement }>();

  constructor(private readonly act: DevicesActions) {
    this.forgetting = new Ask("Forget", act.forget, { "data-forget-ask": "" });
    this.el.append(
      this.title,
      h("h2", { class: "section" }, "Computers"),
      this.computers,
      h("div", { class: "list" }, pill("Pair another computer", act.add, "", { "data-add-computer": "" })),
      this.accounts,
      h("h2", { class: "section" }, "This browser"),
      h("div", { class: "list" }, h("article", { class: "card device" }, this.id)),
      h("div", { class: "list devices-end" },
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
    this.accounts.replaceChildren(...(others.length ? [
      h("h2", { class: "section" }, "Other accounts"),
      h("div", { class: "list" }, ...others.map((a) => h("article", { class: "card device account", "data-account": a.person },
        h("div", { class: "account-who" },
          h("h3", {}, a.name ?? a.computers[0]?.with.name ?? "Account"),
          h("p", { class: "status" }, a.computers.map((c) => c.with.name).join(", "))),
        pill("Switch", () => this.act.switchTo(a.person), "compact", { "data-switch": a.person })))),
    ] : []));
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
        const status = h("span", { class: "status" });
        row = { el: h("article", { class: "card device", "data-computer": c.device }), status, online, id: idLine() };
        this.rows.set(c.device, row);
      }
      if (c.paired) row.el.dataset.paired = c.device;
      else delete row.el.dataset.paired;
      row.el.replaceChildren(
        h("h3", {}, row.online, c.name),
        h("p", { class: "device-state" }, `${KINDS[c.kind] ?? c.kind} · `, row.status),
        row.id);
      row.id.textContent = c.device;
      row.status.textContent = c.live ? "connected" : c.error ? `not reached: ${c.error}` : "connecting…";
      row.status.classList.toggle("problem", !c.live && c.error !== null);
      row.online.toggleAttribute("data-reached", c.live);
      return row.el;
    });
    for (const d of [...this.rows.keys()]) if (!seen.has(d)) this.rows.delete(d);
    this.computers.replaceChildren(...els);
  }
}
