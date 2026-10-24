// ADF ↔ markdown for the fake Rovo MCP server, which speaks markdown only (#189): issue and comment
// bodies stored as ADF go out as markdown, and markdown a client writes is stored as ADF so the
// REST fake reads it back. How Rovo renders panels, mentions, lozenges and media is not published;
// the choices here are marked ASSUMED in fixtures/README.md ("The fake Rovo MCP server").

type Node = { type?: string; text?: string; attrs?: Record<string, unknown>; marks?: { type: string; attrs?: Record<string, unknown> }[]; content?: Node[] };

const inline = (nodes: Node[] = []): string => nodes.map(inlineNode).join("");

function inlineNode(n: Node): string {
  switch (n.type) {
    case "text": {
      let t = n.text ?? "";
      for (const m of n.marks ?? []) {
        if (m.type === "strong") t = `**${t}**`;
        else if (m.type === "em") t = `*${t}*`;
        else if (m.type === "code") t = `\`${t}\``;
        else if (m.type === "strike") t = `~~${t}~~`;
        else if (m.type === "link") t = `[${t}](${String(m.attrs?.href ?? "")})`;
      }
      return t;
    }
    case "hardBreak": return "\n";
    case "mention": return String(n.attrs?.text ?? `@${String(n.attrs?.id ?? "")}`);
    case "status": return `[${String(n.attrs?.text ?? "")}]`;
    case "emoji": return String(n.attrs?.text ?? n.attrs?.shortName ?? "");
    case "inlineCard": return `<${String(n.attrs?.url ?? "")}>`;
    default: return inline(n.content);
  }
}

function block(n: Node, indent = ""): string {
  switch (n.type) {
    case "paragraph": return indent + inline(n.content);
    case "heading": return `${"#".repeat(Number(n.attrs?.level ?? 1))} ${inline(n.content)}`;
    case "codeBlock": return `\`\`\`${String(n.attrs?.language ?? "")}\n${inline(n.content)}\n\`\`\``;
    case "blockquote": return blocks(n.content).split("\n").map((l) => `> ${l}`).join("\n");
    case "panel": return blocks(n.content).split("\n").map((l) => `> ${l}`).join("\n");
    case "rule": return "---";
    case "bulletList": return (n.content ?? []).map((li) => listItem(li, `${indent}- `, indent)).join("\n");
    case "orderedList": return (n.content ?? []).map((li, k) => listItem(li, `${indent}${k + 1}. `, indent)).join("\n");
    case "taskList": return (n.content ?? []).map((ti) => `${indent}- [${ti.attrs?.state === "DONE" ? "x" : " "}] ${inline(ti.content)}`).join("\n");
    case "mediaSingle": case "mediaGroup": return (n.content ?? []).map((m) => `![attachment](${String(m.attrs?.id ?? "")})`).join("\n");
    default: return n.content ? blocks(n.content) : inlineNode(n);
  }
}

function listItem(li: Node, bullet: string, indent: string): string {
  const [first, ...rest] = li.content ?? [];
  const head = first ? (first.type === "paragraph" ? inline(first.content) : block(first)) : "";
  return [bullet + head, ...rest.map((r) => block(r, `${indent}  `))].join("\n");
}

const blocks = (nodes: Node[] = []) => nodes.map((n) => block(n)).join("\n\n");

/** An ADF document as markdown. */
export function adfToMarkdown(doc: unknown): string {
  return blocks((doc as Node | null)?.content);
}

/** Markdown as ADF: paragraphs, headings, bullet, ordered and task lists, fenced code, `**bold**` and links. */
export function markdownToAdf(md: string): { type: "doc"; version: 1; content: Node[] } {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const content: Node[] = [];
  let k = 0;
  while (k < lines.length) {
    const line = lines[k]!;
    if (line.trim() === "") { k++; continue; }
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      for (k++; k < lines.length && !/^```\s*$/.test(lines[k]!); k++) body.push(lines[k]!);
      k++;
      content.push({ type: "codeBlock", ...(fence[1] ? { attrs: { language: fence[1] } } : {}), content: [{ type: "text", text: body.join("\n") }] });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { content.push({ type: "heading", attrs: { level: heading[1]!.length }, content: inlineMd(heading[2]!) }); k++; continue; }
    if (/^\s*[-*] \[[ xX]\] /.test(line)) {
      const items: Node[] = [];
      for (; k < lines.length && /^\s*[-*] \[[ xX]\] /.test(lines[k]!); k++) {
        const m = /^\s*[-*] \[([ xX])\] (.*)$/.exec(lines[k]!)!;
        items.push({ type: "taskItem", attrs: { localId: `md-${items.length}`, state: m[1] === " " ? "TODO" : "DONE" }, content: inlineMd(m[2]!) });
      }
      content.push({ type: "taskList", attrs: { localId: "md" }, content: items });
      continue;
    }
    const listKind = /^\s*[-*] /.test(line) ? "bulletList" : /^\s*\d+\. /.test(line) ? "orderedList" : undefined;
    if (listKind) {
      const re = listKind === "bulletList" ? /^\s*[-*] (.*)$/ : /^\s*\d+\. (.*)$/;
      const items: Node[] = [];
      for (let m; k < lines.length && (m = re.exec(lines[k]!)); k++) items.push({ type: "listItem", content: [{ type: "paragraph", content: inlineMd(m[1]!) }] });
      content.push({ type: listKind, content: items });
      continue;
    }
    const para: string[] = [];
    for (; k < lines.length && lines[k]!.trim() !== "" && !/^(```|#{1,6}\s|\s*[-*] |\s*\d+\. )/.test(lines[k]!); k++) para.push(lines[k]!);
    const parts: Node[] = [];
    para.forEach((p, n) => { if (n) parts.push({ type: "hardBreak" }); parts.push(...inlineMd(p)); });
    content.push({ type: "paragraph", content: parts });
  }
  return { type: "doc", version: 1, content };
}

function inlineMd(s: string): Node[] {
  const out: Node[] = [];
  const re = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`/g;
  let at = 0;
  for (let m; (m = re.exec(s)); at = re.lastIndex) {
    if (m.index > at) out.push({ type: "text", text: s.slice(at, m.index) });
    if (m[1] !== undefined) out.push({ type: "text", text: m[1], marks: [{ type: "strong" }] });
    else if (m[2] !== undefined) out.push({ type: "text", text: m[2], marks: [{ type: "link", attrs: { href: m[3] } }] });
    else out.push({ type: "text", text: m[4]!, marks: [{ type: "code" }] });
  }
  if (at < s.length) out.push({ type: "text", text: s.slice(at) });
  return out;
}

/**
 * Whether a body holds something markdown can't carry. Rovo then answers that body in HTML
 * whatever format was asked for, and says so in `appliedContentFormat` (searchJiraIssuesUsingJql's
 * `responseContentFormat` description, captured 2026-10-19).
 */
export function needsHtml(doc: unknown): boolean {
  const n = doc as Node | null;
  if (!n || typeof n !== "object") return false;
  if (["panel", "mediaSingle", "mediaGroup", "media", "expand", "nestedExpand", "status", "mention"].includes(n.type ?? "")) return true;
  return (n.content ?? []).some(needsHtml);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** An ADF document as HTML, the shape Rovo's html reads take (task lists as `data-type` lists). */
export function adfToHtml(doc: unknown): string {
  const h = (n: Node): string => {
    const kids = () => (n.content ?? []).map(h).join("");
    switch (n.type) {
      case "doc": return kids();
      case "text": {
        let t = esc(n.text ?? "");
        for (const m of n.marks ?? []) {
          if (m.type === "strong") t = `<strong>${t}</strong>`;
          else if (m.type === "em") t = `<em>${t}</em>`;
          else if (m.type === "code") t = `<code>${t}</code>`;
          else if (m.type === "strike") t = `<s>${t}</s>`;
          else if (m.type === "link") t = `<a href="${esc(String(m.attrs?.href ?? ""))}">${t}</a>`;
        }
        return t;
      }
      case "paragraph": return `<p>${kids()}</p>`;
      case "heading": return `<h${Number(n.attrs?.level ?? 1)}>${kids()}</h${Number(n.attrs?.level ?? 1)}>`;
      case "hardBreak": return "<br>";
      case "bulletList": return `<ul>${kids()}</ul>`;
      case "orderedList": return `<ol>${kids()}</ol>`;
      case "listItem": return `<li>${kids()}</li>`;
      case "taskList": return `<ul data-type="task-list">${kids()}</ul>`;
      case "taskItem": return `<li data-type="task-item" data-local-id="${esc(String(n.attrs?.localId ?? ""))}"><input type="checkbox"${n.attrs?.state === "DONE" ? " checked" : ""}>${kids()}</li>`;
      case "codeBlock": return `<pre><code${n.attrs?.language ? ` class="language-${esc(String(n.attrs.language))}"` : ""}>${kids()}</code></pre>`;
      case "blockquote": return `<blockquote>${kids()}</blockquote>`;
      case "panel": return `<div data-panel-type="${esc(String(n.attrs?.panelType ?? "info"))}">${kids()}</div>`;
      case "rule": return "<hr>";
      case "mention": return `<span data-type="mention" data-id="${esc(String(n.attrs?.id ?? ""))}">${esc(String(n.attrs?.text ?? ""))}</span>`;
      case "status": return `<span data-type="status" data-color="${esc(String(n.attrs?.color ?? ""))}">${esc(String(n.attrs?.text ?? ""))}</span>`;
      case "emoji": return esc(String(n.attrs?.text ?? n.attrs?.shortName ?? ""));
      case "inlineCard": return `<a href="${esc(String(n.attrs?.url ?? ""))}">${esc(String(n.attrs?.url ?? ""))}</a>`;
      case "mediaSingle": case "mediaGroup": return kids();
      case "media": return `<img data-media-id="${esc(String(n.attrs?.id ?? ""))}" alt="attachment">`;
      default: return kids();
    }
  };
  return doc && typeof doc === "object" ? h(doc as Node) : "";
}
