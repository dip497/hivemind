// A view that drives agents through protocol 1.4, for view-agents.spec.ts: it keeps what the host
// told it and hands the client to the test.
import { connect } from "@hivemind/view-sdk";
const hm = await connect();
window.hm = hm;
window.structure = { frames: [], tiles: [] };
window.statuses = {};
hm.on("structure", (s) => { window.structure = s; });
window.watch = (tileId) => hm.subscribeStatus(tileId, (status, info) => { (window.statuses[tileId] ??= []).push(info?.agent?.state ?? status); });
document.body.dataset.ready = "1";
document.body.textContent = "agent driver";
