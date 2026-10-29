// A live wallpaper of its own making, for the e2e suite: past the SDK, it keeps every message the
// app sends it, as sent, on `window.heard`, and it can try to take the keyboard (`window.steal`, a
// moment after it is asked, so the asking returns before the app removes the frame).
let port = null;
const heard = [];
window.heard = heard;
window.steal = () => setTimeout(() => {
  const input = document.createElement("input");
  document.body.append(input);
  input.focus();
}, 100);
window.addEventListener("message", (e) => {
  const p = e.ports?.[0];
  if (!p || e.data?.type !== "hivemind-view:port") return;
  port = p;
  port.onmessage = ({ data }) => { heard.push(data); };
  port.start();
  port.postMessage({ type: "ready", protocol: 2 });
  port.postMessage({ type: "drawn" });
});
