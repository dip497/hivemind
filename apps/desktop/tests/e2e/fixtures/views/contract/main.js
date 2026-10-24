// A view that keeps the theme it was told, in its hello and in each `theme` since: what the
// plugin contract spec checks the frozen colours against, on the real page.
import { connect } from "@hivemind/view-sdk";

const hm = await connect();
const keep = (t) => ({ colors: { ...t.colors }, mode: t.mode });
window.__contract = { hello: keep(hm.hello.theme), theme: keep(hm.hello.theme) };
hm.on("theme", (t) => { window.__contract = { ...window.__contract, theme: keep(t) }; });
