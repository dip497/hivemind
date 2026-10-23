// A view that tries what its frame's sandbox decides, for view-sandbox.spec.ts: a form that only
// listens for submit and gives the first tile what was typed, a way to ask for notifications, and
// a fetch that says what it read or that it was refused.
import { connect } from "@hivemind/view-sdk";

const hm = await connect();
let tiles = [];
hm.on("structure", (s) => { tiles = s.tiles; });

const form = document.createElement("form");
const input = Object.assign(document.createElement("input"), { name: "work", placeholder: "Give it work" });
form.append(input);
form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (tiles[0]) hm.prompt(tiles[0].id, input.value).catch(() => {});
});
document.body.append(form);

window.askNotifications = () => Notification.requestPermission();
window.read = (url) => fetch(url).then((r) => (r.ok ? r.json() : `status ${r.status}`), () => "refused");
document.body.dataset.ready = "1";
