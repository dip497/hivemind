// The page's kit: elements made directly, lists kept by key so that only what changed is touched,
// and the Android app's components (Kit.kt) as DOM: pills, the composer, icons.

type Child = Node | string | null | undefined | false;
type Props = Record<string, string | number | boolean | null | undefined>;

/** An element: attributes from `props` (`true` as present, `false` or null as absent), then `children`. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === false || value == null) continue;
    el.setAttribute(name, value === true ? "" : String(value));
  }
  for (const child of children) if (child) el.append(child);
  return el;
}

// Lucide's, as the Android app draws them.
const ICONS = {
  needs: ["M22,12h-6l-2,3h-4l-2,-3H2", "M5.45,5.11L2,12v6a2,2 0,0 0,2 2h16a2,2 0,0 0,2 -2v-6l-3.45,-6.89A2,2 0,0 0,16.76 4H7.24a2,2 0,0 0,-1.79 1.11z"],
  agents: ["M7,11l2,-2l-2,-2", "M11,13h4", "M5,3h14a2,2 0,0 1,2 2v14a2,2 0,0 1,-2 2H5a2,2 0,0 1,-2 -2V5a2,2 0,0 1,2 -2z"],
  devices: ["M18,5a2,2 0,0 1,2 2v8.526a2,2 0,0 0,0.212 0.897l1.068,2.127a1,1 0,0 1,-0.9 1.45H3.62a1,1 0,0 1,-0.9 -1.45l1.068,-2.127A2,2 0,0 0,4 15.526V7a2,2 0,0 1,2 -2z", "M20.054,15.987H3.946"],
  views: ["M4,3h5a1,1 0,0 1,1 1v5a1,1 0,0 1,-1 1H4a1,1 0,0 1,-1 -1V4a1,1 0,0 1,1 -1z", "M15,3h5a1,1 0,0 1,1 1v5a1,1 0,0 1,-1 1h-5a1,1 0,0 1,-1 -1V4a1,1 0,0 1,1 -1z", "M15,14h5a1,1 0,0 1,1 1v5a1,1 0,0 1,-1 1h-5a1,1 0,0 1,-1 -1v-5a1,1 0,0 1,1 -1z", "M4,14h5a1,1 0,0 1,1 1v5a1,1 0,0 1,-1 1H4a1,1 0,0 1,-1 -1v-5a1,1 0,0 1,1 -1z"],
  send: ["M5,12l7,-7l7,7", "M12,19V5"],
  back: ["M19,12H5", "M12,19l-7,-7l7,-7"],
  chevron: ["M9,18l6,-6l-6,-6"],
  down: ["M6,9l6,6l6,-6"],
  chat: ["M21,15a2,2 0,0 1,-2 2H7l-4,4V5a2,2 0,0 1,2 -2h14a2,2 0,0 1,2 2z"],
  more: ["M11,12a1,1 0,1 0,2 0a1,1 0,1 0,-2 0", "M18,12a1,1 0,1 0,2 0a1,1 0,1 0,-2 0", "M4,12a1,1 0,1 0,2 0a1,1 0,1 0,-2 0"],
  plus: ["M5,12h14", "M12,5v14"],
  stop: ["M8,7h8a1,1 0,0 1,1 1v8a1,1 0,0 1,-1 1H8a1,1 0,0 1,-1 -1V8a1,1 0,0 1,1 -1z"],
};

const SVG = "http://www.w3.org/2000/svg";

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, extra = ""): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", `icon ${extra}`.trim());
  svg.setAttribute("aria-hidden", "true");
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/** hivemind's mark: three hexagons, as the launcher icon draws them. */
export function mark(): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 108 108");
  svg.setAttribute("class", "mark");
  svg.setAttribute("aria-hidden", "true");
  const shapes: Array<[string, string]> = [
    ["M0,0H108V108H0Z", "#1A1C1F"],
    ["M54,33.1 L63.96,38.85 L63.96,50.35 L54,56.1 L44.04,50.35 L44.04,38.85 Z", "#E6E7E9"],
    ["M43.18,51.85 L53.14,57.6 L53.14,69.1 L43.18,74.85 L33.22,69.1 L33.22,57.6 Z", "#6B6E72"],
    ["M64.82,51.85 L74.78,57.6 L74.78,69.1 L64.82,74.85 L54.86,69.1 L54.86,57.6 Z", "#7A7D81"],
  ];
  for (const [d, fill] of shapes) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", fill);
    svg.append(path);
  }
  return svg;
}

/**
 * A list kept by key: each item's element is made once, made again only when its signature (what
 * it shows) changed, and moved only when out of place; elements for keys gone are removed. The
 * parent holds these elements and nothing else.
 */
export class Keyed<T> {
  private readonly rows = new Map<string, { el: HTMLElement; sig: string }>();

  constructor(
    readonly parent: HTMLElement,
    private readonly key: (item: T) => string,
    private readonly sig: (item: T) => string,
    private readonly make: (item: T) => HTMLElement,
  ) {}

  set(items: readonly T[]): void {
    const keys = items.map(this.key);
    // Gone first: one left in place until after would put every row past it out of place.
    const seen = new Set(keys);
    for (const [key, row] of this.rows) {
      if (seen.has(key)) continue;
      row.el.remove();
      this.rows.delete(key);
    }
    let at = this.parent.firstChild;
    items.forEach((item, i) => {
      const key = keys[i]!;
      const sig = this.sig(item);
      let row = this.rows.get(key);
      if (!row) {
        row = { el: this.make(item), sig };
        this.rows.set(key, row);
      } else if (row.sig !== sig) {
        const el = this.make(item);
        if (at === row.el) at = el;
        row.el.replaceWith(el);
        row.el = el;
        row.sig = sig;
      }
      if (row.el === at) at = at.nextSibling;
      else this.parent.insertBefore(row.el, at);
    });
  }
}

/** Set `el`'s text to `text`, touching it only when it changed. */
export function say(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** A round button of one icon, named for a screen reader by `label`. */
export function iconButton(name: IconName, label: string, onClick: () => void, props: Props = {}): HTMLButtonElement {
  const button = h("button", { type: "button", class: "icon-button", "aria-label": label, ...props }, icon(name));
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return button;
}

/** A pill button, the Android app's HiveButton. */
export function pill(label: string, onClick: () => void, tone = "", props: Props = {}): HTMLButtonElement {
  const button = h("button", { type: "button", class: `pill ${tone}`.trim(), ...props }, label);
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return button;
}

/** A reply box; `stoppable(on)` says whether what it talks to can be stopped now. */
export type Composer = HTMLFormElement & { stoppable(on: boolean): void };

/**
 * A reply box with a round send button, ready when there is something to send: `send` says whether
 * it went, and the box empties when it did. With `stop`, while it is stoppable and nothing is typed
 * the button stops instead (Happy's agentInputPrimaryAction.ts: typing a follow-up takes priority).
 */
export function composer(hint: string, send: (text: string) => Promise<boolean>, props: Props = {}, stop?: () => void): Composer {
  const field = h("textarea", { rows: 1, placeholder: hint, "aria-label": hint, enterkeyhint: "send" });
  const button = h("button", { type: "submit", class: "send", "aria-label": "Send", disabled: true }, icon("send"));
  const form = Object.assign(h("form", { class: "composer", ...props }, field, button), { stoppable: (on: boolean) => {
    canStop = on;
    ready();
  } });
  let canStop = false;
  let stopping = false;
  const ready = () => {
    const has = field.value.trim() !== "";
    const now = !has && canStop && !!stop;
    button.classList.toggle("ready", has || now);
    button.disabled = !has && !now;
    if (now === stopping) return;
    stopping = now;
    button.type = now ? "button" : "submit";
    button.setAttribute("aria-label", now ? "Stop" : "Send");
    button.toggleAttribute("data-stop", now);
    button.replaceChildren(icon(now ? "stop" : "send"));
  };
  button.addEventListener("click", () => {
    if (stopping) stop!();
  });
  const grow = () => {
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight}px`;
  };
  field.addEventListener("input", () => {
    ready();
    grow();
  });
  // Enter sends where there is a keyboard; on a phone's, Enter is a new line and the button sends.
  field.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && matchMedia("(pointer: fine)").matches) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener("click", (e) => e.stopPropagation());
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = field.value.trim();
    if (!text) return;
    form.inert = true;
    try {
      if (await send(text)) {
        field.value = "";
        grow();
      }
    } finally {
      form.inert = false;
      ready();
    }
  });
  return form;
}

/** A question asked in place of a dialog: the first button runs `yes`; either puts it away. */
export class Ask {
  readonly el: HTMLElement;
  private readonly text = h("p", {});

  constructor(yes: string, onYes: () => void, props: Props = {}) {
    this.el = h("div", { class: "card ask", hidden: true, role: "group", ...props },
      this.text,
      h("div", { class: "row" },
        pill(yes, () => {
          this.el.hidden = true;
          onYes();
        }, "danger", { "data-yes": "" }),
        pill("Cancel", () => (this.el.hidden = true), "", { "data-cancel": "" })));
  }

  ask(question: string): void {
    this.text.textContent = question;
    this.el.hidden = false;
  }
}

/** Choices as the Android app's FilterChips: the one chosen is pressed. */
export function chips<T>(items: readonly T[], label: (item: T) => string, chosen: (item: T) => boolean, choose: (item: T) => void, props: Props = {}): HTMLElement {
  return h("div", { class: "chips", role: "group", ...props },
    ...items.map((item) => {
      const chip = h("button", { type: "button", class: "chip", "aria-pressed": String(chosen(item)) }, label(item));
      chip.addEventListener("click", () => choose(item));
      return chip;
    }));
}
