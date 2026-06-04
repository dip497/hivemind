// One-off README screenshot capture against the REAL current UI.
// Seeds a realistic git repo + .hivemind issues, launches the built Electron
// app, drives the canvas via the same custom events the menus dispatch, and
// writes PNGs to <repo>/screenshots/.  Run under xvfb:
//   xvfb-run -a -s "-screen 0 1600x1000x24" node apps/desktop/tests/capture-readme.mjs
import { _electron as electron } from "@playwright/test";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const APP_DIR = path.resolve(process.cwd(), "apps/desktop");
const OUT = path.resolve(process.cwd(), "screenshots");
const sh = (c, cwd) => execSync(c, { cwd, stdio: "pipe" });
const wait = (p, ms) => p.waitForTimeout(ms);
const ev = (p, name, detail) =>
  p.evaluate(({ name, detail }) => window.dispatchEvent(new CustomEvent(name, { detail })), { name, detail });

// ── seed a believable project ───────────────────────────────────────
const repo = mkdtempSync(path.join(tmpdir(), "hm-shot-"));
sh("git init -q -b main", repo);
sh('git config user.email demo@hivemind.dev', repo);
sh('git config user.name "Demo"', repo);
mkdirSync(path.join(repo, "src"), { recursive: true });
mkdirSync(path.join(repo, "src/auth"), { recursive: true });
mkdirSync(path.join(repo, ".hivemind/issues"), { recursive: true });

writeFileSync(path.join(repo, ".hivemind/config.yaml"), "prefix: PAY\nnext_id: 7\nagents: {}\n");
writeFileSync(path.join(repo, "README.md"), "# acme-pay\n\nPayments service.\n");
writeFileSync(
  path.join(repo, "src/auth/token.ts"),
  `// JWT token verification for the payments gateway.
export interface Token { sub: string; exp: number; scope: string[] }

export function isExpired(t: Token, now = Date.now()): boolean {
  // Bug: should be < not <=, expiry second is still valid.
  return t.exp * 1000 <= now;
}

export function hasScope(t: Token, scope: string): boolean {
  return t.scope.includes(scope);
}

export function verify(raw: string, now = Date.now()): Token | null {
  const t = decode(raw);
  if (!t) return null;
  if (isExpired(t, now)) return null;
  return t;
}

function decode(raw: string): Token | null {
  try { return JSON.parse(atob(raw.split(".")[1])); } catch { return null; }
}
`,
);
writeFileSync(path.join(repo, "src/index.ts"), "export * from './auth/token';\nexport const VERSION = '2.4.0';\n");
sh("git add -A && git commit -qm 'init payments service'", repo);
sh("git update-ref refs/remotes/origin/main HEAD", repo);
// working-tree changes so the diff tile shows real hunks
writeFileSync(
  path.join(repo, "src/auth/token.ts"),
  `// JWT token verification for the payments gateway.
export interface Token { sub: string; exp: number; scope: string[] }

export function isExpired(t: Token, now = Date.now()): boolean {
  // Fixed: expiry second is still valid — use strict less-than.
  return t.exp * 1000 < now;
}

export function hasScope(t: Token, scope: string): boolean {
  return t.scope.includes(scope);
}

export function verify(raw: string, now = Date.now()): Token | null {
  const t = decode(raw);
  if (!t) return null;
  if (isExpired(t, now)) return null;
  if (!hasScope(t, "pay:write")) return null;
  return t;
}

function decode(raw: string): Token | null {
  try { return JSON.parse(atob(raw.split(".")[1])); } catch { return null; }
}
`,
);
writeFileSync(path.join(repo, "src/payments.ts"), "export const fee = (amt: number) => amt * 0.029 + 0.3;\n");

const iso = (d) => new Date(d).toISOString();
const issue = (id, title, state, labels, desc, crit) => {
  const c = crit.map(([done, t]) => `- [${done ? "x" : " "}] ${t}`).join("\n");
  writeFileSync(
    path.join(repo, ".hivemind/issues", `${id}.md`),
    `---
id: ${id}
title: ${title}
state: ${state}
labels: [${labels.join(", ")}]
created: '${iso("2026-05-18T09:00:00Z")}'
updated: '${iso("2026-06-02T14:00:00Z")}'
---

## Description

${desc}

## Acceptance criteria

${c}
`,
  );
};
issue("PAY-1", "Token expiry off-by-one rejects valid sessions", "in_progress", ["bug", "auth"],
  "Sessions are dropped one second early because `isExpired` uses `<=`. Fix the comparison and add a boundary test.",
  [[true, "Reproduce with an exp at the current second"], [true, "Switch `<=` to `<`"], [false, "Add boundary unit test"]]);
issue("PAY-2", "Require pay:write scope on the verify path", "in_review", ["security", "auth"],
  "`verify()` accepts any decoded token. Gate writes behind the `pay:write` scope.",
  [[true, "Add scope check to verify()"], [true, "Reject tokens without pay:write"], [false, "Document the scope in the API"]]);
issue("PAY-3", "Stripe-style percentage fee helper", "todo", ["feature", "billing"],
  "Add a `fee(amount)` helper: 2.9% + 30c, matching the gateway's published schedule.",
  [[false, "Implement fee()"], [false, "Round to cents"], [false, "Unit-test the schedule"]]);
issue("PAY-4", "Idempotency keys on the charge endpoint", "todo", ["reliability"],
  "Duplicate POSTs must not double-charge. Honor an Idempotency-Key header for 24h.",
  [[false, "Persist key → response for 24h"], [false, "Return the cached response on replay"]]);
issue("PAY-5", "Webhook signature verification", "backlog", ["security"],
  "Verify the HMAC signature on inbound provider webhooks before processing.",
  [[false, "Verify HMAC with the signing secret"], [false, "Reject on mismatch"]]);
issue("PAY-6", "Migrate refunds to the v2 ledger", "done", ["billing"],
  "Refunds now post to the double-entry v2 ledger.",
  [[true, "Write to v2 ledger"], [true, "Backfill historical refunds"], [true, "Drop the v1 path"]]);

// ── launch + drive ──────────────────────────────────────────────────
const userData = mkdtempSync(path.join(tmpdir(), "hm-ud-"));
process.env.HIVEMIND_PTY_DAEMON = "0";

const app = await electron.launch({
  args: [path.join(APP_DIR, "out/main/index.js"), "--no-sandbox", `--user-data-dir=${userData}`],
  cwd: repo,
});
const page = await app.firstWindow();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0];
  w.setBounds({ x: 0, y: 0, width: 1440, height: 900 });
});
await page.waitForSelector(".react-flow", { timeout: 20_000 });
await wait(page, 1500);

const shot = async (name) => {
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log("captured", name);
};
// Clicking the empty canvas pane blurs any focused xterm (otherwise Escape goes
// to the terminal, not the canvas) and deselects, so fit-all actually fires.
const fit = async () => {
  await page.locator(".react-flow__pane").click({ position: { x: 6, y: 6 } }).catch(() => {});
  await wait(page, 300);
  await page.keyboard.press("Escape");
  await wait(page, 1100);
};
const toggle = (kind) => ev(page, "hivemind:canvas-toggle", kind);

// ── clean, readable, PII-free shots first (no agent on canvas yet) ──

// 1) Issues board (Plane-style cards on disk)
await toggle("issues");
await page.waitForSelector(".react-flow__node-issues", { timeout: 10_000 }).catch(() => {});
await wait(page, 1200);
await fit();
await shot("01-board");

// 2) New-issue modal
const newBtn = page.getByRole("button", { name: /New issue/ });
if (await newBtn.count()) {
  await newBtn.first().click();
  await wait(page, 700);
  await page.keyboard.type("Add 3-D Secure challenge flow", { delay: 8 });
  await wait(page, 500);
  await shot("02-new-issue");
  await page.keyboard.press("Escape");
  await wait(page, 400);
}

// 3) Diff tile (real hunks from the working-tree change)
await toggle("issues"); // drop the board for a clean diff frame
await wait(page, 500);
await toggle("diff");
await wait(page, 1800);
await fit();
await shot("03-diff");

// 4) Explorer + diff side by side
await toggle("tree");
await wait(page, 1200);
await fit();
await shot("04-tree-diff");

// ── agent shots: spawn claude, accept the first-run trust gate, send a real
//    prompt so the account-banner scrolls off (keeps PII out of the frame). ──
const sendToClaude = async (text) => {
  const term = page.locator(".xterm").last();
  await term.click({ position: { x: 120, y: 120 } }).catch(() => {});
  await wait(page, 500);
  await page.keyboard.press("Enter"); // trust gate: default "Yes"
  await wait(page, 2500);
  await page.keyboard.type(text, { delay: 12 });
  await wait(page, 400);
  await page.keyboard.press("Enter");
};

await ev(page, "hivemind:spawn-claude", {});
await wait(page, 7000);
await sendToClaude("In one sentence, what is the bug in src/auth/token.ts isExpired?");
await wait(page, 22000); // let claude read the file + answer; banner scrolls away
await fit();
await shot("05-agent");

// 6) Wide mission-control overview — board + explorer + diff + agents. At this
//    zoom the agent banner text is sub-pixel/illegible, so no PII is readable.
await toggle("issues");
await wait(page, 600);
await ev(page, "hivemind:spawn-claude", {});
await wait(page, 6000);
await fit();
await shot("06-overview");

await app.close();
sh(`rm -rf ${repo} ${userData}`, process.cwd());
console.log("done →", OUT);
