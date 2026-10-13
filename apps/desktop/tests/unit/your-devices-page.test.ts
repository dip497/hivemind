// Your devices: the browser card is the switch and its link. The port and other names, which most
// people never set, are folded under More options, closed, with what they are for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { YourDevicesPrefs } from "../../src/renderer/src/settings-devices.tsx";

const page = renderToStaticMarkup(createElement(YourDevicesPrefs));
const card = page.slice(page.indexOf('data-connect="browser"'), page.indexOf("</section>", page.indexOf('data-connect="browser"')));
const folded = /<details[^>]*>(?:(?!<\/details>)[\s\S])*<\/details>/.exec(card)?.[0] ?? "";

test("the browser card shows its switch, and folds the port and other names under a closed More options", () => {
  assert.match(card, /role="switch"[^>]*aria-label="Serve the app to a browser"|aria-label="Serve the app to a browser"[^>]*role="switch"/);
  assert.match(folded, /^<details(?![^>]*\bopen\b)[^>]*>/);
  assert.match(folded, /<summary[^>]*>More options/);
  for (const shown of ['id="browser-app-port"', 'id="browser-app-names"', "tailscale serve"]) {
    assert.ok(folded.includes(shown), `${shown} is under More options`);
    assert.ok(!card.replace(folded, "").includes(shown), `${shown} is not outside it`);
  }
});
