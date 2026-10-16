# Architecture debt

Notes on structure that is wrong or will be, written when it was found and left for later, in the
`talk-is-cheap` shape. Each says when it is worth doing; delete a note when it is done.

## Plugins tell agents nothing on their own (2026-10-16)

```
Architecture: acceptable now, wrong at the next agent feature that waits on a plugin
What:     an agent learns what a plugin did only by calling it again; plugins cannot send it anything
Why:      polling a command an agent chose stands in for an event → each agent re-implements its loop
Refactor: `hive ctl plugin watch [--plugin p]`: NDJSON of the lifecycle's transitions, and events a plugin emits for agents
Shape:    view-host/instances.ts already fires every transition (`changed()`) → expose it as a stream on the drive socket, as `agent.list --watch` does
Steps:    host method `plugin.watch` streaming PluginInstance changes → SDK `hm.tellAgents(name, data)` → CLI verb → e2e
Size:     ~6 files, one protocol bump (view protocol + workspace API) | the maintainer decides the SDK name
When:     next change here
```

## A plugin command's argument is free text (2026-10-16)

```
Architecture: acceptable
What:     a manifest's command says what it takes as prose (`args: '{ "text": string }'`), not a schema
Why:      an agent cannot check an argument before calling → a typo costs a round trip and a FAILED
Refactor: `argsSchema` (JSON Schema, draft 2020-12 subset) beside `args`, checked in the window before `invoke`
Shape:    PluginCommand { name, description, args?, argsSchema? } → instances.call validates → BAD_REQUEST names the field
Steps:    add the optional field to the manifest and SDK → validate in PluginInstances.call → show it in `plugin list --json`
Size:     ~4 files, tests | which schema subset to accept
When:     when a third-party plugin with commands ships on HiveHub
```

## Plugins run only in a window (2026-10-16)

```
Architecture: acceptable (a written ceiling)
What:     `hive host` has no window, so every `plugin.*` call there is UNAVAILABLE
Why:      a plugin's code runs in the window's sandboxed frame or worker → no headless runtime exists
Refactor: none until a headless host must run plugins; then a worker runtime in the host feeding the same PluginInstances
Size:     large: a sandbox for plugin code in Node or Bun | a security review
When:     never, unless headless hosts need plugins
```

## The phone answers the wait it finds at send time (2026-10-16)

```
Architecture: wrong (suspected; the composer now guards it)
What:     AgentViewModel.answer() picks which wait to answer when Send is pressed, not the one the person was typing for
Why:      the decision sits in the view model, after the fact → a wait that changed while typing is answered by mistake; ComposerTarget's guard patches one path
Refactor: answer(since, answer): the screen passes the wait it showed; the core refuses a stale `since`
Shape:    Composer(typedFor) → vm.answer(text) → core.answer(currentSince) ⇒ Composer(typedFor) → vm.answer(typedFor.since, text) → core.answer(since)
Steps:    add the parameter in the core (hive-phone) → pass it from both apps → drop the guard → tests on a stale since
Size:     ~6 files across Rust, Kotlin and Swift; bindings regenerated
When:     next change to answering on the phone
```

## Two JSON shapes from one CLI (2026-10-16)

```
Architecture: acceptable
What:     `hive widgets|tools|views|plugins list --json` print `{ok, data}`; `hive ctl … --json` prints the result itself
Why:      two conventions grew in two command families → a script parses each differently
Refactor: one shape (the result itself; errors as `{ok:false, code, message}`), with **Breaking:** in the CHANGELOG
When:     at the next breaking CLI change, together
```
