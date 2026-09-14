/** `hive push` — notify a phone (ntfy, or any URL taking a plain-text POST) when an agent on this machine needs input. */
import { defineCommand } from "citty";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { err, ok } from "../format.js";
import { EXIT } from "../hcp.js";
import { defaultSocket } from "../pty-client.js";

const TOPICS = ["notification", "turn"];
const socketArg = { socket: { type: "string", description: "daemon socket whose machine this configures (default: this machine's)" } } as const;
const file = (sock?: unknown) => path.join(path.dirname(String(sock || defaultSocket())), "push.json");

interface PushConfig { url: string; events: string[] }

function read(p: string): PushConfig | null {
  try { return JSON.parse(fs.readFileSync(p, "utf8")) as PushConfig; } catch { return null; }
}

function validUrl(u: string): boolean {
  try { return ["http:", "https:"].includes(new URL(u).protocol); } catch { return false; }
}

async function post(url: string, body: string): Promise<void> {
  const r = await fetch(url, { method: "POST", body, headers: { Title: `hivemind - ${os.hostname()}` }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
}

const setCmd = defineCommand({
  meta: { name: "set", description: "Push to this URL (e.g. https://ntfy.sh/<your-topic>)" },
  args: {
    url: { type: "positional", required: true },
    events: { type: "string", description: `comma-separated: ${TOPICS.join(",")} (default: notification — an agent needs input)` },
    ...socketArg,
    json: { type: "boolean" },
  },
  run({ args }) {
    const ctx = { json: !!args.json };
    const url = String(args.url);
    if (!validUrl(url)) return err(ctx, "usage", "the push URL must be http:// or https://", EXIT.usage);
    const events = args.events ? String(args.events).split(",").map((e) => e.trim()).filter(Boolean) : ["notification"];
    const bad = events.filter((e) => !TOPICS.includes(e));
    if (bad.length) return err(ctx, "usage", `unknown event ${bad.join(", ")} — use ${TOPICS.join(", ")}`, EXIT.usage);
    const p = file(args.socket);
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, `${JSON.stringify({ url, events } satisfies PushConfig, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(p, 0o600);
    return ok(ctx, { url, events }, () => `pushing ${events.join(" + ")} to ${url} — try \`hive push test\``);
  },
});

const offCmd = defineCommand({
  meta: { name: "off", description: "Stop pushing" },
  args: { ...socketArg, json: { type: "boolean" } },
  run({ args }) {
    const ctx = { json: !!args.json };
    fs.rmSync(file(args.socket), { force: true });
    return ok(ctx, { enabled: false }, () => "push is off");
  },
});

const statusCmd = defineCommand({
  meta: { name: "status", description: "Where pushes go" },
  args: { ...socketArg, json: { type: "boolean" } },
  run({ args }) {
    const ctx = { json: !!args.json };
    const c = read(file(args.socket));
    return ok(ctx, c ? { enabled: true, ...c } : { enabled: false }, () => (c ? `pushing ${c.events.join(" + ")} to ${c.url}` : "push is off — `hive push set <url>`"));
  },
});

const testCmd = defineCommand({
  meta: { name: "test", description: "Send a test push now" },
  args: { ...socketArg, json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const c = read(file(args.socket));
    if (!c) return err(ctx, "push_off", "push is off — `hive push set <url>` first", EXIT.usage);
    try { await post(c.url, "test push from hivemind"); } catch (e) { return err(ctx, "push_failed", (e as Error).message, EXIT.unavailable); }
    return ok(ctx, { sent: true, url: c.url }, () => `sent a test push to ${c.url}`);
  },
});

export const pushCmd = defineCommand({
  meta: { name: "push", description: "Phone notifications when an agent on this machine needs you" },
  subCommands: { set: setCmd, off: offCmd, status: statusCmd, test: testCmd },
});
