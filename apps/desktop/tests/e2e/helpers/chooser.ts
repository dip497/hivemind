import fs from "node:fs";
import path from "node:path";

/** A stand-in agent that asks as Claude Code does: told `perm`, its PermissionRequest hook reports
 *  the wait first, and its chooser takes keys only once drawn, `$CHOOSER_LATE` seconds later; what
 *  was typed before then never reaches it. A digit 1 or 2 allows (PostToolUse), Esc interrupts
 *  with no hook, as Claude Code's does; anything else denies. While `$CHOOSER_LOG.deaf` is there,
 *  its chooser ignores every key. It writes each key it took, and each
 *  it never saw, to `$CHOOSER_LOG`. Its hooks come as Claude Code's do, a `--settings` document.
 *  What the desktop's environment needs to run it. */
export function chooserAgent(root: string): Record<string, string> {
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
    "hook SessionStart",
    "printf 'chooser> '",
    "printf 'settings %s\\n' \"$settings\" >>\"${CHOOSER_TRACE:-/dev/null}\"",
    "while read -r line; do",
    "  printf 'heard %s\\n' \"$line\" >>\"${CHOOSER_TRACE:-/dev/null}\"",
    "  hook UserPromptSubmit",
    "  if [ \"$line\" = perm ]; then",
    "    hook PermissionRequest",
    "    sleep \"${CHOOSER_LATE:-2}\"",
    "    while read -rsn1 -t 0.05 early; do printf 'missed %q\\n' \"$early\" >> \"$CHOOSER_LOG\"; done",
    "    printf '\\033[2J\\033[H Bash command\\n   rm -rf build\\n Do you want to proceed?\\n > 1. Yes\\n   2. Yes, and do not ask again\\n   3. No\\n'",
    "    read -rsn1 key",
    // Deaf, it takes no key: its chooser stays.
    "    while [ -e \"$CHOOSER_LOG.deaf\" ]; do printf 'ignored %q\\n' \"$key\" >> \"$CHOOSER_LOG\"; read -rsn1 key; done",
    "    case \"$key\" in",
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
    "    PermissionRequest: { emit: input.requested, kind: permission, timeout: 10 }",
    "    PostToolUse: { emit: input.resolved, timeout: 10 }",
    "    PermissionDenied: { emit: input.resolved, timeout: 10 }",
    "",
  ].join("\n"));
  return { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, CHOOSER_LOG: path.join(root, "chooser.log") };
}
