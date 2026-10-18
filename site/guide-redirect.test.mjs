// An old guide link has to land on the same page of the docs site, and only once the site is named.
import { test } from "node:test";
import assert from "node:assert/strict";
import { docsSiteFrom, guideRedirectFor } from "./guide-redirect.mjs";

const docs = "https://docs.example.com";

test("a guide page goes to the page of the same name on the docs site", () => {
  assert.equal(guideRedirectFor("/guide/getting-started/", docs), `${docs}/getting-started`);
  assert.equal(guideRedirectFor("/guide/api-connect", docs), `${docs}/api-connect`);
  assert.equal(guideRedirectFor("/guide/", docs), `${docs}/`);
  assert.equal(guideRedirectFor("/guide", docs), `${docs}/`);
  assert.equal(guideRedirectFor("/guide/cli/?x=1", docs), `${docs}/cli?x=1`);
});

test("nothing outside the guide moves", () => {
  for (const p of ["/", "/download", "/plugins/", "/guidebook", "/guide/a/b", "/shots/guide/x.png"]) {
    assert.equal(guideRedirectFor(p, docs), null, p);
  }
});

test("with no docs site named, the guide stays where it is", () => {
  assert.equal(docsSiteFrom({}), null);
  assert.equal(docsSiteFrom({ DOCS_SITE_URL: "" }), null);
  assert.equal(docsSiteFrom({ DOCS_SITE_URL: "docs.example.com" }), null);
  assert.equal(guideRedirectFor("/guide/cli/", docsSiteFrom({})), null);
  assert.equal(docsSiteFrom({ DOCS_SITE_URL: "https://docs.example.com/" }), docs);
});
