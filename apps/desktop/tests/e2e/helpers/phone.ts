// What the phone specs share (M5): Settings → Devices → Pair a phone on the person's computer, read
// as the phone reads it, and a stand-in agent there that keeps its conversation as Claude Code does.
import { expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/** Settings → Devices → Pair a phone on the person's computer `desktop`: a QR code of its link (read
 *  here off its Copy button, as the phone reads it off the code). The link. */
export async function offerPhonePairing(desktop: Page): Promise<string> {
  await desktop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "devices" } })));
  await desktop.locator("[data-pair-phone]").click();
  await expect(desktop.locator('[data-pair-offered="phone"] [data-pair-qr]')).toBeVisible();
  const link = (await desktop.locator("[data-pair-copy]").getAttribute("title"))!;
  expect(link).toMatch(/^hivemind:\/\/pair\//);
  return link;
}

/** A stand-in agent that keeps its conversation as Claude Code does, installed for the person whose
 *  data is under `root/desktop`: given `--session-id <id>` as it starts (its manifest binds one), it
 *  writes each line it is given, and its reply, as Claude Code's records to `<home>/talk/<id>.jsonl`,
 *  which its manifest names as its session file, and says `heard: <line>` on its screen. Given
 *  `/clear`, it begins another session, recorded for its tile in `$TALKER_TRACKS` as Claude Code's
 *  tracker hook records one, its file written from the next line on. What the desktop's environment
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
    "detect: { default: idle, rules: [] }", "",
  ].join("\n"));
  return { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` };
}
