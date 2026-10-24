// A view that paints with a token of its own and shows what it was set to: the view the
// customization spec checks a token and every kind of setting through, from Settings to the view,
// and the themes spec a theme's font faces through (the SDK loads them into document.fonts).
import { applyThemeVars, connect } from "@hivemind/view-sdk";

const hm = await connect();
applyThemeVars(hm);
document.body.style.cssText = "margin:0;height:100vh;background:var(--hm-token-sea, #000);color:#fff;font:14px system-ui";
const out = document.createElement("pre");
document.body.append(out);
const show = () => {
  const sea = getComputedStyle(document.documentElement).getPropertyValue("--hm-token-sea").trim();
  window.__looks = { sea, settings: { ...hm.settings }, tokens: hm.supports("tokens"), fontFaces: hm.supports("fontFaces") };
  out.textContent = JSON.stringify(window.__looks, null, 1);
};
show();
hm.on("theme", () => requestAnimationFrame(show));
hm.on("settings", () => requestAnimationFrame(show));
