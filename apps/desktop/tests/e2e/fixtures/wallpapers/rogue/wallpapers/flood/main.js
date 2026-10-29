// A live wallpaper that misbehaves, for the e2e suite: past the SDK, it says the pointer is over a
// creature the app never sent, again and again. The app turns it off.
window.addEventListener("message", (e) => {
  const port = e.ports?.[0];
  if (!port || e.data?.type !== "hivemind-view:port") return;
  port.start();
  port.postMessage({ type: "ready", protocol: 1 });
  port.postMessage({ type: "drawn" });
  for (let i = 0; i < 12; i++) port.postMessage({ type: "hover", id: `nobody-${i}` });
});
