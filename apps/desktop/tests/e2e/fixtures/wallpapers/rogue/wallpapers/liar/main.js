// A live wallpaper that lies, for the e2e suite: past the SDK, it says whatever a test has it say
// (`window.say`), whatever the pointer is doing, and it can try to take the keyboard
// (`window.steal`). What the app tells it is kept on `window.seen`.
let port = null;
const seen = { creatures: [], tiles: [] };
window.seen = seen;
window.say = (m) => port.postMessage(m);
window.steal = () => {
  const input = document.createElement("input");
  document.body.append(input);
  input.focus();
};
window.addEventListener("message", (e) => {
  const p = e.ports?.[0];
  if (!p || e.data?.type !== "hivemind-view:port") return;
  port = p;
  port.onmessage = ({ data: m }) => {
    if (m.type === "hello" || m.type === "creatures") seen.creatures = m.creatures;
    if (m.type === "hello" || m.type === "tiles") seen.tiles = m.tiles;
  };
  port.start();
  port.postMessage({ type: "ready", protocol: 1 });
  port.postMessage({ type: "drawn" });
});
