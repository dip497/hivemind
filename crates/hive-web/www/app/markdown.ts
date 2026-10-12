// What an agent says, which is markdown, read by the core (spec/markdown.md) and drawn here: text
// only ever as text nodes, a link only where the core found an https address. Its styles are
// `.md`'s, the class of what holds it.

import { readMarkdown } from "../pkg/hive_web.js";
import { h } from "./dom.js";

type Run = { text: string; strong?: boolean; emphasis?: boolean; strike?: boolean; code?: boolean; image?: boolean; link?: string };
type Marker = { is: "bullet" } | { is: "number"; n: number } | { is: "task"; done: boolean };
type Align = "none" | "left" | "center" | "right";
type Block = (
  | { is: "paragraph"; runs: Run[] }
  | { is: "heading"; level: number; runs: Run[] }
  | { is: "code"; language?: string; text: string }
  | { is: "rule" }
  | { is: "table"; align: Align[]; head: Run[][]; rows: Run[][][] }
) & { depth?: number; quote?: number; marker?: Marker };

const opens = (link: string) => ({ href: link, target: "_blank", rel: "noopener noreferrer" });

function run(r: Run): Node {
  let node: Node = document.createTextNode(r.text);
  if (r.code) node = h("code", {}, node);
  if (r.strike) node = h("s", {}, node);
  if (r.emphasis) node = h("em", {}, node);
  if (r.strong) node = h("strong", {}, node);
  // An image by its words: nothing is fetched to draw it.
  if (r.image) return h(r.link ? "a" : "span", { class: "image", "data-image": "", ...(r.link ? opens(r.link) : {}) }, node);
  return r.link ? h("a", opens(r.link), node) : node;
}

const runs = (rs: Run[]) => rs.map(run);

function drawn(b: Block): HTMLElement {
  switch (b.is) {
    // Each its own direction, from its first strong character, as the agent wrote it.
    case "paragraph": return h("p", { dir: "auto" }, ...runs(b.runs));
    case "heading": return h(`h${Math.min(Math.max(b.level, 1), 6)}` as "h1", { dir: "auto" }, ...runs(b.runs));
    case "rule": return h("hr");
    case "code": return h("div", { class: "code" }, b.language ? h("span", { class: "language", "data-language": "" }, b.language) : null, h("pre", {}, h("code", {}, b.text)));
    case "table": {
      const cell = (tag: "th" | "td", rs: Run[], i: number) => {
        const el = h(tag, { dir: "auto" }, ...runs(rs));
        if (b.align[i] && b.align[i] !== "none") el.style.textAlign = b.align[i]!;
        return el;
      };
      return h("div", { class: "table" }, h("table", {},
        h("thead", {}, h("tr", {}, ...b.head.map((c, i) => cell("th", c, i)))),
        h("tbody", {}, ...b.rows.map((row) => h("tr", {}, ...row.map((c, i) => cell("td", c, i)))))));
    }
  }
}

/** In a list, `el` set in by its depth, after its item's marker when it starts one. */
function listed(b: Block, el: HTMLElement): HTMLElement {
  if (!b.depth) return el;
  const m = b.marker;
  const marker = !m ? h("span", {})
    : m.is === "task" ? h("span", { "data-marker": "" }, h("input", { type: "checkbox", checked: m.done, disabled: true, "aria-label": m.done ? "Done" : "Not done" }))
    : h("span", { "data-marker": "" }, m.is === "number" ? `${m.n}.` : "•");
  const item = h("div", { class: "item" }, marker, el);
  item.style.setProperty("--depth", String(b.depth - 1));
  return item;
}

export function markdown(text: string): HTMLElement[] {
  const top = h("div");
  // The quotes open, the outermost first.
  const quotes: HTMLElement[] = [top];
  for (const b of readMarkdown(text) as Block[]) {
    const depth = b.quote ?? 0;
    while (quotes.length - 1 > depth) quotes.pop();
    while (quotes.length - 1 < depth) {
      const quote = h("blockquote");
      quotes.at(-1)!.append(quote);
      quotes.push(quote);
    }
    quotes.at(-1)!.append(listed(b, drawn(b)));
  }
  return [...top.children] as HTMLElement[];
}
