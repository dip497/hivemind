// A view that shows the workspace's widgets (protocol 1.8): each widget's name and the label of
// each of its buttons, which press it. Written against the raw protocol, as a phone's view runs.
window.addEventListener("message", (e) => {
  const port = e.ports && e.ports[0];
  if (!port || !e.data || e.data.type !== "hivemind-view:port") return;
  port.start();
  port.postMessage({ type: "ready", v: 1 });
  const buttons = (tree, out = []) => {
    if (tree && typeof tree === "object") {
      if (tree.type === "button") out.push(tree);
      for (const c of Array.isArray(tree.children) ? tree.children : []) buttons(c, out);
    }
    return out;
  };
  port.onmessage = (m) => {
    const d = m.data || {};
    if (d.type === "hello") {
      document.body.dataset.features = (d.features || []).join(",");
      document.body.dataset.capabilities = (d.capabilities || []).join(",");
      if ((d.features || []).includes("widgets")) port.postMessage({ type: "subscribeWidgets" });
    }
    if (d.type === "widgets") {
      const list = document.getElementById("list");
      list.replaceChildren();
      for (const w of d.widgets) {
        const card = document.createElement("section");
        card.dataset.widget = w.widget;
        card.textContent = w.name + " ";
        for (const b of buttons(w.tree)) {
          const button = document.createElement("button");
          button.textContent = b.label;
          button.onclick = () => port.postMessage({ type: "pressWidget", id: w.id, action: b.action });
          card.append(button);
        }
        list.append(card);
      }
    }
  };
});
// Says when the pointer reaches it: a frame just shown gets input only once the window routes it there.
document.addEventListener("pointermove", () => { document.body.dataset.pointer = "1"; });
