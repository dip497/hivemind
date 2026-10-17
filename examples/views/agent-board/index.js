// A board the agents write to: each `hive ctl plugin call agent-board post '{"text":"…"}'` pins a
// note, newest first, which everyone looking at this view sees. The notes are kept with the
// workspace (the view's layout), so they are there when the app starts again.
import { applyThemeVars, connect } from "@hivemind/view-sdk";

const hm = await connect();
applyThemeVars(hm);

let notes = Array.isArray(hm.hello.layout?.notes) ? hm.hello.layout.notes : [];
const KINDS = { done: "var(--hm-status-done)", blocked: "var(--hm-status-attention)", note: "var(--hm-color-fg3)" };

document.body.style.cssText = "margin:0;font:13px system-ui;background:transparent;color:var(--hm-color-fg)";
const root = document.createElement("main");
root.style.cssText = "max-width:760px;margin:0 auto;padding:72px 24px;display:flex;flex-direction:column;gap:10px";
document.body.append(root);

function draw() {
  root.replaceChildren();
  const h = document.createElement("h1");
  h.textContent = "Agent board";
  h.style.cssText = "font-size:18px;margin:0 0 8px";
  root.append(h);
  if (!notes.length) {
    const p = document.createElement("p");
    p.textContent = "Nothing yet. An agent pins a note with: hive ctl plugin call agent-board post '{\"text\":\"…\"}'";
    p.style.opacity = "0.7";
    root.append(p);
  }
  for (const n of notes) {
    const card = document.createElement("article");
    card.dataset.note = n.kind;
    card.style.cssText = `padding:10px 12px;border-radius:10px;background:rgba(127,127,127,.12);border-left:3px solid ${KINDS[n.kind] ?? KINDS.note}`;
    const meta = document.createElement("div");
    meta.textContent = `${n.from} · ${new Date(n.at).toLocaleTimeString()} · ${n.kind}`;
    meta.style.cssText = "font-size:11px;opacity:.65;margin-bottom:4px";
    const text = document.createElement("div");
    text.textContent = n.text;
    card.append(meta, text);
    root.append(card);
  }
}

function keep(next) {
  notes = next.slice(0, 200);
  hm.setLayout({ notes });
  draw();
}

hm.onCommand("post", (a) => {
  if (!a || typeof a.text !== "string" || !a.text.trim()) throw new Error("text is required");
  const kind = ["done", "blocked", "note"].includes(a.kind) ? a.kind : "note";
  const note = { text: a.text.trim().slice(0, 2000), from: typeof a.from === "string" && a.from.trim() ? a.from.trim().slice(0, 60) : "an agent", kind, at: Date.now() };
  keep([note, ...notes]);
  return { notes: notes.length };
});
hm.onCommand("list", () => notes);
hm.onCommand("clear", () => { keep([]); return { notes: 0 }; });

draw();
