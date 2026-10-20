// The picture a link to the site shows when it is shared (og:image): 1200×630, drawn from the
// site's own type, colours and hero still, and saved as public/shots/og.jpg.
//
//   npm run social-card          (needs Playwright's Chromium: npx playwright install chromium)
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const at = (p) => new URL(`../${p}`, import.meta.url).pathname;
const base64 = (p) => readFileSync(at(p)).toString("base64");

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:Geist;src:url(data:font/woff2;base64,${base64("public/fonts/geist-latin.woff2")}) format("woff2");font-weight:100 900}
*{box-sizing:border-box;margin:0}
body{width:1200px;height:630px;overflow:hidden;background:oklch(0.165 0.004 250);font-family:Geist,sans-serif;color:oklch(0.93 0.004 250);position:relative}
.grid{position:absolute;inset:0;background-image:radial-gradient(oklch(0.32 0.005 250) 1.2px,transparent 1.3px);background-size:24px 24px;
  mask-image:linear-gradient(90deg,#000 0%,#000 40%,transparent 75%)}
.shot{position:absolute;left:600px;top:92px;width:760px;border-radius:14px;border:1px solid oklch(0.32 0.005 250);
  box-shadow:0 30px 80px rgba(0,0,0,.55);overflow:hidden}
.shot img{display:block;width:100%}
.shot::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,oklch(0.165 0.004 250 / .35),transparent 30%)}
.copy{position:absolute;left:72px;top:72px;width:560px;height:486px;display:flex;flex-direction:column}
.brand{display:flex;align-items:center;gap:14px;font-size:30px;font-weight:600;letter-spacing:-.02em}
h1{margin-top:auto;font-size:62px;line-height:1.02;letter-spacing:-.04em;font-weight:600}
h1 span{color:oklch(0.62 0.006 250)}
p{margin-top:26px;font-size:25px;line-height:1.35;color:oklch(0.80 0.005 250);max-width:30ch}
</style></head><body>
<div class="grid"></div>
<div class="shot"><img src="data:image/webp;base64,${base64("src/assets/hero/school-of-agents.webp")}"></div>
<div class="copy">
  <div class="brand"><svg width="38" height="38" viewBox="0 0 24 24">
    <path d="M11.14 1.70 Q12 1.20 12.86 1.70 L16.51 3.80 Q17.37 4.30 17.37 5.29 L17.37 9.51 Q17.37 10.50 16.51 11 L12.86 13.10 Q12 13.60 11.14 13.10 L7.49 11 Q6.63 10.50 6.63 9.51 L6.63 5.29 Q6.63 4.30 7.49 3.80 Z" fill="currentColor"/>
    <path d="M5.60 11.30 Q6.46 10.80 7.32 11.30 L10.97 13.40 Q11.83 13.90 11.83 14.89 L11.83 19.11 Q11.83 20.10 10.97 20.60 L7.32 22.70 Q6.46 23.20 5.60 22.70 L1.95 20.60 Q1.09 20.10 1.09 19.11 L1.09 14.89 Q1.09 13.90 1.95 13.40 Z" fill="currentColor" opacity=".4"/>
    <path d="M16.68 11.30 Q17.54 10.80 18.40 11.30 L22.05 13.40 Q22.91 13.90 22.91 14.89 L22.91 19.11 Q22.91 20.10 22.05 20.60 L18.40 22.70 Q17.54 23.20 16.68 22.70 L13.03 20.60 Q12.17 20.10 12.17 19.11 L12.17 14.89 Q12.17 13.90 13.03 13.40 Z" fill="currentColor" opacity=".4"/>
  </svg>Hivemind</div>
  <h1><span>Your agents build</span> the workspace they work in.</h1>
  <p>Claude Code, Codex and every coding agent, side by side.</p>
</div>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(html);
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: at("public/shots/og.jpg"), type: "jpeg", quality: 88 });
await browser.close();
console.log("social card: public/shots/og.jpg, 1200×630");
