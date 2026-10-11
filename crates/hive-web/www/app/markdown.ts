// What an agent says is markdown: drawn as the Android app draws it (its Markdown.kt), the kind
// agents write and nothing more: paragraphs, headings, list items, fenced code, `code` and
// **strong**. Text only ever becomes text nodes.

import { h } from "./dom.js";

type Block = { text: string; is: "text" | "heading" | "code" } | { text: string; is: "item"; marker: string };

const HEADING = /^#{1,6}\s+(.*)$/;
const ITEM = /^\s*([-*+]|\d+[.)])\s+(.*)$/;

function blocks(markdown: string): Block[] {
  const out: Block[] = [];
  let paragraph: string[] = [];
  let code: string[] | null = null;
  const paragraphEnds = () => {
    if (paragraph.join("").trim()) out.push({ is: "text", text: paragraph.join("\n") });
    paragraph = [];
  };
  for (const line of markdown.split("\n")) {
    const fence = line.trimStart().startsWith("```");
    if (code) {
      if (fence) {
        out.push({ is: "code", text: code.join("\n") });
        code = null;
      } else code.push(line);
      continue;
    }
    const headed = HEADING.exec(line);
    const listed = ITEM.exec(line);
    if (fence) {
      paragraphEnds();
      code = [];
    } else if (!line.trim()) paragraphEnds();
    else if (headed) {
      paragraphEnds();
      out.push({ is: "heading", text: headed[1]! });
    } else if (listed) {
      paragraphEnds();
      const marker = listed[1]!;
      out.push({ is: "item", marker: /\d/.test(marker[0]!) ? marker : "•", text: listed[2]! });
    } else paragraph.push(line);
  }
  // A fence not closed yet: the agent is still saying it.
  if (code) out.push({ is: "code", text: code.join("\n") });
  paragraphEnds();
  return out;
}

/** `text`'s inline marks; a mark not closed is only a character written. */
function inline(text: string): Node[] {
  const out: Node[] = [];
  let at = 0;
  while (at < text.length) {
    const tick = text.indexOf("`", at);
    const stars = text.indexOf("**", at);
    const next = [tick, stars].filter((i) => i >= 0).sort((a, b) => a - b)[0];
    if (next === undefined) break;
    const mark = next === tick ? "`" : "**";
    const end = text.indexOf(mark, next + mark.length);
    if (end < 0) {
      out.push(document.createTextNode(text.slice(at, next + mark.length)));
      at = next + mark.length;
      continue;
    }
    out.push(document.createTextNode(text.slice(at, next)));
    out.push(h(mark === "`" ? "code" : "b", {}, text.slice(next + mark.length, end)));
    at = end + mark.length;
  }
  if (at < text.length) out.push(document.createTextNode(text.slice(at)));
  return out;
}

export function markdown(text: string): HTMLElement[] {
  return blocks(text).map((b) => {
    switch (b.is) {
      case "text": return h("p", {}, ...inline(b.text));
      case "heading": return h("h4", {}, ...inline(b.text));
      case "item": return h("div", { class: "item" }, h("span", {}, b.marker), h("span", {}, ...inline(b.text)));
      case "code": return h("pre", {}, b.text);
    }
  });
}
