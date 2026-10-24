// A view that paints with a token of its own and shows what it was set to: the view the
// customization spec checks a token and every kind of setting through, from Settings to the view.
// Its foam is a colour setting with a colour as its default; "" is the theme's text colour.
import { applyThemeVars, connect } from "@hivemind/view-sdk";

const hm = await connect();
applyThemeVars(hm);
document.body.style.cssText = "margin:0;height:100vh;background:var(--hm-token-sea, #000);color:#fff;font:14px system-ui";
const out = document.createElement("pre");
document.body.append(out);
const show = () => {
  const css = getComputedStyle(document.documentElement);
  const sea = css.getPropertyValue("--hm-token-sea").trim();
  const foam = hm.settings.foam || css.getPropertyValue("--hm-color-fg").trim();
  window.__looks = { sea, foam, settings: { ...hm.settings }, tokens: hm.supports("tokens") };
  out.textContent = JSON.stringify(window.__looks, null, 1);
};
show();
hm.on("theme", () => requestAnimationFrame(show));
hm.on("settings", () => requestAnimationFrame(show));
