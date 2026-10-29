// A live wallpaper that misbehaves, for the e2e suite: past the SDK, it sends what is no message,
// again and again. The app turns it off.
window.addEventListener("message", (e) => {
  const port = e.ports?.[0];
  if (!port || e.data?.type !== "hivemind-view:port") return;
  port.start();
  port.postMessage({ type: "ready", protocol: 2 });
  port.postMessage({ type: "drawn" });
  for (let i = 0; i < 12; i++) port.postMessage({ type: "spawn", agent: `nobody-${i}` });
});
