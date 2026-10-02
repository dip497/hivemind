// A community view's page on the phone, joined to the app (docs/design/phone-app-2026-10-02.md
// §6.1). The app runs this at the start of the page, in the page's own world. It hands the view SDK
// its port as the computer's windows do: a `hivemind-view:port` window message once the page has
// loaded. It relays that port to the app, each message as JSON text: to the app through the `hive`
// object the app gives the page (iOS: `webkit.messageHandlers.hive`; Android: its web message
// listener's `hive`); from the app through `hive.onmessage` (Android) or `__hive.said(text)`
// (iOS: `callAsyncJavaScript`). Nothing else of the app's is reachable from the page.
(() => {
  "use strict";
  const ios = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.hive;
  const app = ios || window.hive;
  if (!app || window.__hive) return;
  const { port1: port, port2: theirs } = new MessageChannel();
  // What the view posts, to the app: JSON text, or nothing when it is not JSON.
  port.onmessage = (event) => {
    let text;
    try {
      text = JSON.stringify(event.data);
    } catch {
      return;
    }
    if (typeof text === "string") app.postMessage(text);
  };
  // What its host says, from the app, to the view: dropped when it is not JSON.
  const said = (text) => {
    if (typeof text !== "string") return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    port.postMessage(message);
  };
  Object.defineProperty(window, "__hive", { value: Object.freeze({ said }) });
  if (!ios) app.onmessage = (event) => said(event.data);
  const hand = () => window.postMessage({ type: "hivemind-view:port" }, "*", [theirs]);
  if (document.readyState === "complete") hand();
  else window.addEventListener("load", hand, { once: true });
})();
