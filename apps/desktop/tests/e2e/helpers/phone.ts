// What the phone specs share (M5): Settings → Connect on the person's computer, its offer read as the
// phone reads it, the person there saying the phone is theirs, a camera showing its QR code, and a
// stand-in agent there that keeps its conversation as Claude Code does.
import { expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { encode } from "uqr";

/** A camera pointed at `text`'s QR code, black on white, as Chromium's fake camera plays it
 *  (`--use-file-for-fake-video-capture=<file>`): a Y4M file, written over whatever it showed. */
export function cameraOn(file: string, text: string): void {
  const [W, H] = [640, 480];
  const { data, size } = encode(text, { border: 4 });
  const scale = Math.floor(H / size);
  const [left, top] = [(W - size * scale) >> 1, (H - size * scale) >> 1];
  const luma = Buffer.alloc(W * H, 235);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!data[y]![x]) continue;
      for (let dy = 0; dy < scale; dy++) luma.fill(16, (top + y * scale + dy) * W + left + x * scale, (top + y * scale + dy) * W + left + (x + 1) * scale);
    }
  }
  const frame = Buffer.concat([Buffer.from("FRAME\n"), luma, Buffer.alloc((W / 2) * (H / 2) * 2, 128)]);
  fs.writeFileSync(file, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`), frame, frame]));
}

/** Settings → Connect on the person's computer `desktop`, left open there: its offer, and the link a
 *  phone's camera reads off its QR code (here off its Copy button). With `inBrowser`, the phone
 *  page's address carrying it, where the network's server serves the page. */
export async function offerToConnect(desktop: Page, inBrowser = false): Promise<string> {
  await desktop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "connect" } })));
  await desktop.locator("[data-connect-offer]").click();
  // The offer runs hive-net (a voucher on a closed network): seconds on a loaded machine.
  await expect(desktop.locator("[data-connect-qr]")).toBeVisible({ timeout: 20_000 });
  if (inBrowser) await desktop.locator('[data-connect-way="browser"]').click();
  const link = (await desktop.locator("[data-connect-copy]").getAttribute("title"))!;
  expect(link).toMatch(inBrowser ? /#connect=/ : /^hivemind:\/\/connect\//);
  return link;
}

/** The person at `desktop` says the device asking with its offer is theirs. */
export async function itsMe(desktop: Page, timeout = 30_000): Promise<void> {
  await desktop.locator("[data-connect-request]").getByRole("button", { name: "It's me — the words match" }).click({ timeout });
}

/** The phone page `page`, opened at an offer from `desktop`: it connects, the person at the computer
 *  says it is theirs, and the person at the phone that the words match. */
export async function connectPage(page: Page, desktop: Page): Promise<void> {
  await page.locator("[data-pair]").click({ timeout: 30_000 });
  await itsMe(desktop);
  await page.locator("[data-connect-yes]").click({ timeout: 30_000 });
}

/** A stand-in agent that keeps its conversation as Claude Code does, installed for the person whose
 *  data is under `root/desktop`: given `--session-id <id>` as it starts (its manifest binds one), it
 *  writes each line it is given, and its reply, as Claude Code's records to `<home>/talk/<id>.jsonl`,
 *  which its manifest names as its session file, and says `heard: <line>` on its screen. Given
 *  `/clear`, it begins another session, recorded for its tile in `$TALKER_TRACKS` as Claude Code's
 *  tracker hook records one, its file written from the next line on. Given `ask`, it asks which
 *  color, Red or Blue, a key choosing (Esc, its interrupt key, too); given `run`, to run a command, `y` or `n`. What the desktop's environment
 *  needs to run it. */
export function talkerAgent(root: string): Record<string, string> {
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "talker-agent"), [
    "#!/bin/bash",
    "id=''",
    "while [ $# -gt 0 ]; do case \"$1\" in --session-id) id=\"$2\"; shift 2;; *) shift;; esac; done",
    "mkdir -p \"$HOME/talk\"",
    "f=\"$HOME/talk/$id.jsonl\"",
    "printf 'talker> '",
    "n=0",
    "while read -r line; do",
    "  if [ \"$line\" = /clear ]; then",
    "    id=\"$id-2\"; f=\"$HOME/talk/$id.jsonl\"",
    "    t=$(printf '%s' \"$HIVEMIND_TILE\" | base64 | tr '+/' '-_' | tr -d '=')",
    "    mkdir -p \"$TALKER_TRACKS\" && printf '{\"session_id\":\"%s\"}' \"$id\" > \"$TALKER_TRACKS/$t.json\"",
    "    printf 'cleared\\n'; continue",
    "  fi",
    // Told `ask` or `run`, it records the tool it asks to use as Claude Code does, asks on its
    // screen, and takes one key as the answer.
    "  if [ \"$line\" = ask ] || [ \"$line\" = run ]; then",
    "    n=$((n+1)); at=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)",
    "    if [ \"$line\" = ask ]; then",
    "      use='\"name\":\"AskUserQuestion\",\"input\":{\"questions\":[{\"question\":\"Which color?\",\"options\":[{\"label\":\"Red\"},{\"label\":\"Blue\"}],\"multiSelect\":false}]}'",
    "      screen='Which color?\\n 1. Red\\n 2. Blue\\n'",
    "    else",
    "      use='\"name\":\"Bash\",\"input\":{\"command\":\"rm -rf build\\nmake all\"}'",
    "      screen='Run this command? (y/n)\\n'",
    "    fi",
    "    printf '{\"type\":\"assistant\",\"uuid\":\"t%s\",\"timestamp\":\"%s\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"tu%s\",%s}]}}\\n' \"$n\" \"$at\" \"$n\" \"$use\" >> \"$f\"",
    "    printf \"\\033[2J\\033[H$screen\"",
    "    read -rsn1 key; [ \"$key\" = $'\\e' ] && key=esc",
    "    printf '{\"type\":\"assistant\",\"uuid\":\"k%s\",\"timestamp\":\"%s\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"%s answered %s\"}]}}\\n' \"$n\" \"$at\" \"$line\" \"$key\" >> \"$f\"",
    "    printf '\\033[2J\\033[H%s answered %s\\n' \"$line\" \"$key\"; continue",
    "  fi",
    "  n=$((n+1)); at=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)",
    "  printf '{\"type\":\"user\",\"uuid\":\"p%s\",\"timestamp\":\"%s\",\"message\":{\"role\":\"user\",\"content\":\"%s\"}}\\n' \"$n\" \"$at\" \"$line\" >> \"$f\"",
    "  printf '{\"type\":\"assistant\",\"uuid\":\"a%s\",\"timestamp\":\"%s\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"You said %s\"}]}}\\n' \"$n\" \"$at\" \"$line\" >> \"$f\"",
    "  printf 'heard: %s\\n' \"$line\"",
    "done",
  ].join("\n"), { mode: 0o755 });
  const agent = path.join(root, "desktop", "hivemind", "agents", "talker");
  fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(path.join(agent, "agent.yaml"), [
    "manifestVersion: 2", "id: talker", "label: Talker", "bin: talker-agent", "enabled: true",
    "caps: { promptDelivery: typed, turnSignal: false, resume: tile, supervise: human, blockedDetection: false }",
    // As Claude Code's: its tile is in its environment, where its tracker finds it.
    "launch: { hcp: true }",
    "session:",
    "  bind: { args: [--session-id, '{newId}'] }",
    "  resume: { args: [--resume, '{id}'], from: { bound: --session-id }, exists: '{home}/talk/{id}.jsonl' }",
    // Its session file mapped as any agent's is: its records' fields, nothing Hivemind knows.
    "  transcript:",
    "    id: uuid",
    "    at: timestamp",
    "    said:",
    "    - { require: { type: user }, text: message.content, who: person }",
    "    - { require: { type: assistant }, each: message.content, item: { type: text }, text: text, who: agent }",
    "    - require: { type: assistant }", "      each: message.content", "      item: { type: tool_use }",
    "      tool: { id: id, name: name, about: [input.command], input: input, asks: { list: input.questions, question: question, options: options, label: label, many: multiSelect } }",
    "answer: { permission: { allow: ['y'], deny: ['n'] } }",
    "choose: ['{n}']",
    "interrupt: [escape]",
    "detect:", "  default: idle", "  rules:",
    "  - when: { contains: 'Which color?' }", "    then: question",
    "  - when: { contains: 'Run this command?' }", "    then: permission", "",
  ].join("\n"));
  return { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` };
}

/** A stand-in agent, read from its screen: it says what it is doing in its title, and asks to
 *  edit a file until it is answered, then draws its screen afresh, working, and says each line it
 *  hears from then on. Told no, it says so and asks again a moment later; its manifest says `y`
 *  and Enter allow what it asks and `n` and Enter deny it. What the desktop's environment needs to
 *  run it, for the person whose data is under `root/desktop`. */
export function probeAgent(root: string): Record<string, string> {
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "probe-agent"), [
    "#!/bin/bash",
    "printf '\\033]0;Editing Nav.tsx\\007'",
    "while :; do",
    "  printf 'Allow edit to Nav.tsx? (y/n) '",
    "  read -r answer",
    "  [ \"$answer\" = n ] || break",
    "  printf '\\033[2J\\033[Hprobe was told no\\n'",
    "  sleep 2",
    "done",
    "printf '\\033[2J\\033[Hprobe is thinking\\n'",
    "while read -r line; do printf 'heard: %s\\n' \"$line\"; done",
  ].join("\n"), { mode: 0o755 });
  const agent = path.join(root, "desktop", "hivemind", "agents", "probe");
  fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(path.join(agent, "agent.yaml"), [
    "manifestVersion: 2", "id: probe", "label: Probe", "bin: probe-agent", "enabled: true",
    "caps: { promptDelivery: typed, turnSignal: false, resume: none, supervise: human, blockedDetection: true }",
    "answer: { permission: { allow: ['y', enter], deny: ['n', enter] } }",
    "detect:", "  default: idle", "  rules:",
    "  - when: { contains: 'Allow edit to Nav.tsx?' }", "    then: permission",
    "  - when: { contains: probe is thinking }", "    then: working", "",
  ].join("\n"));
  return { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` };
}

/** The stand-in agent started on the board of the person's computer `desktop`: its tile. */
export async function startProbe(desktop: Page): Promise<string> {
  await desktop.evaluate(() => window.hive.settingsSet("agents.defaultAgent", "probe"));
  await desktop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:shortcut", { detail: "agent" })));
  const terminal = desktop.locator(".react-flow__node-terminal");
  await expect(terminal).toHaveCount(1, { timeout: 20_000 });
  return (await terminal.getAttribute("data-id"))!;
}
