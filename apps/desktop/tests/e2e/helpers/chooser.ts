import fs from "node:fs";
import path from "node:path";

/** A stand-in agent that asks as Claude Code does: told `perm`, its PermissionRequest hook reports
 *  the wait first, and its chooser takes keys only once drawn, `$CHOOSER_LATE` seconds later; what
 *  was typed before then never reaches it. A digit 1 or 2 allows (PostToolUse), Esc interrupts
 *  with no hook, as Claude Code's does; anything else denies. While `$CHOOSER_LOG.deaf` is there,
 *  its chooser ignores every key. It writes each key it took, and each
 *  it never saw, to `$CHOOSER_LOG`. Its hooks come as Claude Code's do, a `--settings` document.
 *  `held`: its PermissionRequest hook carries the answer, and runs while its chooser is up, as
 *  Claude Code's does; the first to answer wins. It writes `drawn` once its chooser is up, then
 *  what the hook printed (`hook said`), or that the hook ended with nothing (`hook let go`).
 *  `hookFor`: it ends that hook after so many seconds, its chooser still up, as Claude Code ends
 *  one that runs out of time. `about`: its manifest maps its tool uses as Claude Code's does
 *  (`session.transcript`), so what its permission is about (`rm -rf build`) is known, as Claude's
 *  is. What the desktop's environment needs to run it. */
export function chooserAgent(root: string, { held = false, hookFor, about = false }: { held?: boolean; hookFor?: number; about?: boolean } = {}): Record<string, string> {
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "chooser-agent"), [
    "#!/bin/bash",
    "settings=''",
    "while [ $# -gt 0 ]; do case \"$1\" in --settings) settings=\"$2\"; shift 2;; *) shift;; esac; done",
    "export SETTINGS=\"$settings\"",
    // Every command its settings give for the event, run as Claude Code runs a hook.
    "hook() {",
    "  node -e 'for (const g of JSON.parse(process.env.SETTINGS || \"{}\").hooks?.[process.argv[1]] ?? []) for (const h of g.hooks ?? []) console.log(h.command)' \"$1\" |",
    "  while IFS= read -r c; do printf '{\"session_id\":\"s1\",\"hook_event_name\":\"%s\"}' \"$1\" | sh -c \"$c\" >>\"${CHOOSER_TRACE:-/dev/null}\" 2>&1; printf 'hook %s ran %s\\n' \"$1\" \"$?\" >>\"${CHOOSER_TRACE:-/dev/null}\"; done",
    "}",
    // Its PermissionRequest hook, its output kept: the answer, when it carries one.
    "ask() {",
    "  node -e 'for (const g of JSON.parse(process.env.SETTINGS || \"{}\").hooks?.PermissionRequest ?? []) for (const h of g.hooks ?? []) console.log(h.command)' |",
    "  while IFS= read -r c; do printf '{\"session_id\":\"s1\",\"hook_event_name\":\"PermissionRequest\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"rm -rf build\"}}' | ${CHOOSER_HOOK_FOR:+timeout \"$CHOOSER_HOOK_FOR\"} sh -c \"$c\" 2>>\"${CHOOSER_TRACE:-/dev/null}\"; done",
    "}",
    "hook SessionStart",
    "printf 'chooser> '",
    "printf 'settings %s\\n' \"$settings\" >>\"${CHOOSER_TRACE:-/dev/null}\"",
    "while read -r line; do",
    "  printf 'heard %s\\n' \"$line\" >>\"${CHOOSER_TRACE:-/dev/null}\"",
    "  hook UserPromptSubmit",
    "  if [ \"$line\" = perm ]; then",
    "    said=\"$CHOOSER_LOG.said\"; : > \"$said\"",
    "    if [ -n \"$CHOOSER_HELD\" ]; then ( ask > \"$said\"; [ -s \"$said\" ] || printf 'hook let go\\n' >> \"$CHOOSER_LOG\" ) & else hook PermissionRequest; fi",
    "    sleep \"${CHOOSER_LATE:-2}\"",
    "    while read -rsn1 -t 0.05 early; do printf 'missed %q\\n' \"$early\" >> \"$CHOOSER_LOG\"; done",
    "    printf '\\033[2J\\033[H Bash command\\n   rm -rf build\\n Do you want to proceed?\\n > 1. Yes\\n   2. Yes, and do not ask again\\n   3. No\\n'",
    "    [ -z \"$CHOOSER_HELD\" ] || printf 'drawn\\n' >> \"$CHOOSER_LOG\"",
    "    key=''",
    // Held, its hook may answer first: it waits on both.
    "    if [ -n \"$CHOOSER_HELD\" ]; then",
    "      while :; do",
    "        if [ -s \"$said\" ]; then printf 'hook said %s\\n' \"$(cat \"$said\")\" >> \"$CHOOSER_LOG\"; key=hook; break; fi",
    "        read -rsn1 -t 0.1 key && break",
    "      done",
    "    else read -rsn1 key; fi",
    // Deaf, it takes no key: its chooser stays.
    "    while [ -e \"$CHOOSER_LOG.deaf\" ]; do printf 'ignored %q\\n' \"$key\" >> \"$CHOOSER_LOG\"; read -rsn1 key; done",
    "    case \"$key\" in",
    "      hook) case \"$(cat \"$said\")\" in *allow*) hook PostToolUse; printf '\\033[2J\\033[Hran it\\n' ;; *) hook PermissionDenied; printf '\\033[2J\\033[Hdenied\\n' ;; esac ;;",
    "      1|2) printf 'took %s\\n' \"$key\" >> \"$CHOOSER_LOG\"; hook PostToolUse; printf '\\033[2J\\033[Hran it\\n' ;;",
    "      $'\\e') printf 'took esc\\n' >> \"$CHOOSER_LOG\"; printf '\\033[2J\\033[H  Interrupted by user\\nchooser> '; continue ;;",
    "      *) printf 'took %q\\n' \"$key\" >> \"$CHOOSER_LOG\"; hook PermissionDenied; printf '\\033[2J\\033[Hdenied\\n' ;;",
    "    esac",
    "  fi",
    "  hook Stop",
    "  printf 'chooser> '",
    "done",
  ].join("\n"), { mode: 0o755 });
  const agent = path.join(root, "desktop", "hivemind", "agents", "chooser");
  fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(path.join(agent, "agent.yaml"), [
    "manifestVersion: 2", "id: chooser", "label: Chooser", "bin: chooser-agent", "enabled: true",
    "caps: { promptDelivery: typed, turnSignal: true, resume: none, supervise: human, blockedDetection: true }",
    "launch: { hcp: true }",
    "answer: { permission: { allow: ['1'], deny: [escape] } }",
    "interrupt: [escape]",
    "detect:", "  default: working", "  rules:",
    "  - when: { contains: 'Do you want to proceed?' }", "    then: permission",
    "  - when: { contains: 'chooser>' }", "    then: idle",
    "hooks:",
    "  arg: --settings",
    "  template: '{\"hooks\":{events}}'",
    "  events:",
    "    SessionStart: { emit: session.started, timeout: 10 }",
    "    UserPromptSubmit: { emit: turn.started, timeout: 10 }",
    "    Stop: { emit: turn.ended, outcome: done, timeout: 10 }",
    held
      ? "    PermissionRequest: { emit: input.requested, kind: permission, timeout: 3600, answer: { allow: { decision: { behavior: allow } }, deny: { decision: { behavior: deny, message: '{message}' } } } }"
      : "    PermissionRequest: { emit: input.requested, kind: permission, timeout: 10 }",
    "    PostToolUse: { emit: input.resolved, timeout: 10 }",
    "    PermissionDenied: { emit: input.resolved, timeout: 10 }",
    ...(about ? [
      "session:",
      "  resume: { args: ['--resume', '{id}'], exists: '{home}/.chooser/{id}.jsonl' }",
      "  transcript:",
      "    id: uuid",
      "    at: timestamp",
      "    said:",
      "    - require: { type: assistant }",
      "      each: message.content",
      "      item: { type: tool_use }",
      "      tool: { id: id, name: name, about: [input.command], input: input }",
    ] : []),
    "",
  ].join("\n"));
  return { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, CHOOSER_LOG: path.join(root, "chooser.log"), ...(held ? { CHOOSER_HELD: "1" } : {}), ...(hookFor ? { CHOOSER_HOOK_FOR: String(hookFor) } : {}) };
}
