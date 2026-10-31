/**
 * Notes on a Browser tile's page: what is at a point or in an area of the page, the highlight
 * while pointing, the picture a note keeps, numbered pins on the page, and holding its animations
 * still. All of it through the page's DevTools session, so the page's own code is never changed
 * and its content security policy does not apply. A point is a fraction of the page's visible
 * width and height, as a viewer anywhere sends it (page-stream.ts).
 */
import type { WebContents } from "electron";
import type { PageBox, PageElement, ReviewStatus } from "@hivemind/core/review";

type Send = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

function session(page: WebContents): Send {
  if (!page.debugger.isAttached()) page.debugger.attach("1.3");
  return (method, params = {}) => page.debugger.sendCommand(method, params);
}

/** The page's visible size, in CSS pixels, and how far it is scrolled. */
async function viewport(send: Send): Promise<{ width: number; height: number; x: number; y: number }> {
  const m = (await send("Page.getLayoutMetrics")) as { cssVisualViewport: { clientWidth: number; clientHeight: number; pageX: number; pageY: number } };
  const v = m.cssVisualViewport;
  return { width: v.clientWidth, height: v.clientHeight, x: v.pageX, y: v.pageY };
}

/** Run in the page with `this` the element: a selector that finds it alone, its text, the text
 *  around it, and its box on the page. */
const DESCRIBE = `function () {
  const el = this;
  const clean = (t) => (t || "").replace(/\\s+/g, " ").trim();
  const cut = (t, n) => { t = clean(t); return t.length > n ? t.slice(0, n - 1) + "\\u2026" : t; };
  const esc = (v) => CSS.escape(v);
  const alone = (sel) => { try { const m = document.querySelectorAll(sel); return m.length === 1 && m[0] === el; } catch { return false; } };
  // A part of five or more characters mixing letters and digits is a build's hash, not a name.
  const steady = (w) => /^[a-zA-Z][\\w-]{1,40}$/.test(w) && !w.includes("__") && !w.split(/[-_]+/).some((p) => p.length >= 5 && /\\d/.test(p) && /[a-z]/i.test(p));
  const named = ["data-testid", "data-test", "data-qa", "data-cy", "name", "aria-label"];
  const own = (n) => {
    if (n.id && steady(n.id)) return "#" + esc(n.id);
    for (const a of named) {
      const v = n.getAttribute(a);
      if (v && v.length < 80) return n.localName + "[" + a + "=" + JSON.stringify(v) + "]";
    }
    return n.localName + [...n.classList].filter(steady).slice(0, 2).map((c) => "." + esc(c)).join("");
  };
  const nth = (n) => {
    const p = n.parentElement;
    if (!p) return "";
    const same = [...p.children].filter((c) => c.localName === n.localName);
    return same.length > 1 ? ":nth-of-type(" + (same.indexOf(n) + 1) + ")" : "";
  };
  let selector = null;
  const parts = [];
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    const plain = [own(n), ...parts].join(" > ");
    if (alone(plain)) { selector = plain; break; }
    const counted = own(n) + nth(n);
    parts.unshift(counted);
    if (alone(parts.join(" > "))) { selector = parts.join(" > "); break; }
  }
  selector = selector || parts.join(" > ");
  const field = el.localName === "input" || el.localName === "textarea" || el.localName === "select";
  const text = cut(field ? (el.value || el.placeholder || "") : (el.innerText || el.textContent || ""), 120);
  const side = (n) => n ? cut(n.innerText || n.textContent || "", 60) : "";
  const before = side(el.previousElementSibling), after = side(el.nextElementSibling);
  const nearby = [before && "before \\u201c" + before + "\\u201d", after && "after \\u201c" + after + "\\u201d"].filter(Boolean).join(", ");
  const r = el.getBoundingClientRect();
  return { selector, text, nearby, tag: el.localName,
    box: { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), width: Math.round(r.width), height: Math.round(r.height) } };
}`;

/** Run in the page: the elements worth naming inside an area of its view, innermost first. */
const INSIDE = `function (x, y, w, h) {
  const worth = "a,button,input,select,textarea,img,svg,video,h1,h2,h3,h4,h5,h6,p,li,label,td,th,[role]";
  const meets = (r) => r.width >= 8 && r.height >= 8 && r.right > x && r.left < x + w && r.bottom > y && r.top < y + h;
  const found = [...document.querySelectorAll(worth)].filter((e) => meets(e.getBoundingClientRect()));
  return found.filter((e) => !found.some((o) => o !== e && e.contains(o))).slice(0, 20);
}`;

interface Described { selector: string; text: string; nearby: string; tag: string; box: PageBox }

/** What a person calls the element: its role and accessible name, as the browser computes them. */
async function nameOf(send: Send, backendNodeId: number, d: Described): Promise<string> {
  try {
    const ax = (await send("Accessibility.getPartialAXTree", { backendNodeId, fetchRelatives: false })) as {
      nodes: { ignored?: boolean; role?: { value?: string }; name?: { value?: string } }[];
    };
    const node = ax.nodes[0];
    const role = node?.role?.value;
    const name = node?.name?.value?.replace(/\s+/g, " ").trim() || d.text;
    if (node && !node.ignored && role && role !== "generic" && role !== "none") return name ? `${role} "${name.slice(0, 80)}"` : role;
  } catch { /* no accessibility tree for it */ }
  return d.text ? `${d.tag} "${d.text.slice(0, 60)}"` : d.tag;
}

async function describe(send: Send, objectId: string): Promise<PageElement> {
  const { result } = (await send("Runtime.callFunctionOn", { objectId, functionDeclaration: DESCRIBE, returnByValue: true })) as { result: { value: Described } };
  const d = result.value;
  const { node } = (await send("DOM.describeNode", { objectId })) as { node: { backendNodeId: number } };
  return {
    name: await nameOf(send, node.backendNodeId, d),
    selector: d.selector,
    ...(d.text ? { text: d.text } : {}),
    ...(d.nearby ? { nearby: d.nearby } : {}),
    box: d.box,
  };
}

/** The element at a point of the page's view, seeing past layers that let the pointer through. */
async function nodeAt(send: Send, fx: number, fy: number): Promise<number | null> {
  const v = await viewport(send);
  await send("DOM.getDocument", { depth: 0 });
  try {
    const r = (await send("DOM.getNodeForLocation", { x: Math.round(fx * v.width), y: Math.round(fy * v.height) })) as { backendNodeId: number };
    return r.backendNodeId;
  } catch {
    return null;
  }
}

async function objectOf(send: Send, backendNodeId: number): Promise<string> {
  const { object } = (await send("DOM.resolveNode", { backendNodeId })) as { object: { objectId: string } };
  return object.objectId;
}

/** What is at a point of the page; null where there is nothing. */
export async function elementAt(page: WebContents, fx: number, fy: number): Promise<PageElement | null> {
  const send = session(page);
  const id = await nodeAt(send, fx, fy);
  if (id === null) return null;
  // A text node or a pseudo-element names the element that holds it.
  const objectId = await objectOf(send, id);
  const { result } = (await send("Runtime.callFunctionOn", { objectId, functionDeclaration: "function () { return this.nodeType === 1 ? this : this.parentElement; }" })) as { result: { objectId?: string } };
  return result.objectId ? describe(send, result.objectId) : null;
}

/** An area of the page's view, given as fractions, in page coordinates, and the elements in it. */
export async function elementsIn(page: WebContents, fx: number, fy: number, fw: number, fh: number): Promise<{ area: PageBox; elements: PageElement[] }> {
  const send = session(page);
  const v = await viewport(send);
  const [x, y, w, h] = [fx * v.width, fy * v.height, fw * v.width, fh * v.height];
  const { result } = (await send("Runtime.evaluate", { expression: `(${INSIDE})(${x}, ${y}, ${w}, ${h})` })) as { result: { objectId?: string } };
  const elements: PageElement[] = [];
  if (result.objectId) {
    const { result: props } = (await send("Runtime.getProperties", { objectId: result.objectId, ownProperties: true })) as { result: { name: string; value?: { objectId?: string } }[] };
    for (const p of props) if (/^\d+$/.test(p.name) && p.value?.objectId) elements.push(await describe(send, p.value.objectId));
  }
  return { area: { x: Math.round(x + v.x), y: Math.round(y + v.y), width: Math.round(w), height: Math.round(h) }, elements };
}

/** Outline what is at a point, as the inspector does; no point: none. */
export async function highlightAt(page: WebContents, point: { fx: number; fy: number } | null): Promise<void> {
  const send = session(page);
  if (!point) { await send("Overlay.hideHighlight").catch(() => {}); return; }
  const id = await nodeAt(send, point.fx, point.fy);
  if (id === null) return;
  await send("Overlay.enable");
  await send("Overlay.highlightNode", {
    backendNodeId: id,
    highlightConfig: { showInfo: true, contentColor: { r: 59, g: 130, b: 246, a: 0.22 }, borderColor: { r: 59, g: 130, b: 246, a: 0.9 } },
  });
}

/** A picture of a box of the page, with a margin, at most `longest` pixels on its long side. */
export async function pictureOf(page: WebContents, box: PageBox, longest = 1600): Promise<Buffer> {
  const send = session(page);
  const pad = 24;
  const x = Math.max(0, box.x - pad), y = Math.max(0, box.y - pad);
  const width = Math.max(1, box.width + pad * 2), height = Math.max(1, box.height + pad * 2);
  const scale = Math.min(1, longest / Math.max(width, height));
  const { data } = (await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x, y, width, height, scale } })) as { data: string };
  return Buffer.from(data, "base64");
}

/** The smallest box around all of them. */
export function around(boxes: readonly PageBox[]): PageBox {
  const x = Math.min(...boxes.map((b) => b.x)), y = Math.min(...boxes.map((b) => b.y));
  return { x, y, width: Math.max(...boxes.map((b) => b.x + b.width)) - x, height: Math.max(...boxes.map((b) => b.y + b.height)) - y };
}

/** A note's numbered pin on the page. */
export interface PagePin { n: number; status: ReviewStatus; selector?: string; box: PageBox }

/** Run in the page: one layer of its own, holding the pins, placed on the element each points at
 *  while it is there (else where it was), and kept in place as the page lays out again. */
const PINS = `function (pins) {
  const TAG = "hivemind-page-notes";
  let host = document.querySelector(TAG);
  if (!pins.length) { if (host) host.remove(); return; }
  if (!host) {
    host = document.createElement(TAG);
    const root = host.attachShadow({ mode: "open" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(":host{position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none}" +
      ".pin{position:absolute;min-width:22px;height:22px;padding:0 6px;border-radius:11px;box-sizing:border-box;font:600 12px/22px system-ui,sans-serif;text-align:center;color:#fff;box-shadow:0 1px 4px rgba(0,0,0,.35);transform:translate(-50%,-50%)}" +
      ".open{background:#2563eb}.seen{background:#d97706}.resolved{background:#16a34a}.dismissed{background:#6b7280}");
    root.adoptedStyleSheets = [sheet];
    document.documentElement.appendChild(host);
    new ResizeObserver(() => host.place && host.place()).observe(document.documentElement);
  }
  const root = host.shadowRoot;
  root.replaceChildren(...pins.map((p) => {
    const d = document.createElement("div");
    d.className = "pin " + p.status;
    d.textContent = p.status === "resolved" ? "\\u2713" : String(p.n);
    d.dataset.n = String(p.n);
    return d;
  }));
  host.place = () => pins.forEach((p, i) => {
    let b = p.box;
    try {
      const el = p.selector && document.querySelector(p.selector);
      if (el) { const r = el.getBoundingClientRect(); b = { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; }
    } catch {}
    const d = root.children[i];
    d.style.left = b.x + "px";
    d.style.top = b.y + "px";
  });
  host.place();
}`;

/** Show these pins on the page, in place of any it shows. */
export async function showPins(page: WebContents, pins: readonly PagePin[]): Promise<void> {
  const send = session(page);
  await send("Runtime.evaluate", { expression: `(${PINS})(${JSON.stringify(pins)})` });
}

/** Hold the page's animations, transitions and playing media still, or let them go again. */
export async function holdStill(page: WebContents, still: boolean): Promise<void> {
  const send = session(page);
  await send("Animation.enable");
  await send("Animation.setPlaybackRate", { playbackRate: still ? 0 : 1 });
  await send("Runtime.evaluate", {
    expression: still
      ? `document.querySelectorAll("video,audio").forEach((m) => { if (!m.paused) { m.dataset.hivemindHeld = "1"; m.pause(); } })`
      : `document.querySelectorAll("[data-hivemind-held]").forEach((m) => { delete m.dataset.hivemindHeld; m.play().catch(() => {}); })`,
  });
}
