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

## Who may report is tied to a flag, not to reporting (2026-10-17)

```
Architecture: acceptable now, wrong at the first manifest that reports only through `{emit:…}`
What:     a hook signs in with HCP_TOKEN, which only `launch.hcp` gives; `emit:` entries require the flag, the `{emit:<event>}` placeholder in an asset, template or home file does not
Why:      two routes to the same generic hook, one rule checked on one of them → such a manifest validates and every event it reports is dropped unsigned
Refactor: the manifest says whether it reports once (any `emit:` entry or `{emit:` text), and that one fact both requires `launch.hcp` and is shown in the disclosure
Shape:    manifest.ts `reports` reads hooks.events only → a `reportsEvents(def, assetSource)` in runtime-manifest.ts that also scans asset/home/template text, called by load-time validation
Steps:    add the check where assets are read at load → refuse with the same message → test: an asset with `{emit:turn.ended}` and no hcp is refused
Size:     2 files, 1 test | none for the reader
When:     before HiveHub accepts a manifest whose assets carry `{emit:`; none do today (faux and the bundled ones set hcp)
```

## The daemon's sign-in form is proven only where hive-net is built (2026-10-17)

```
Architecture: acceptable
What:     the standalone daemon taking `initialize` as a notification (how hooks sign in) is exercised only by the native-door test, which skips without crates/hive-net built; the other daemon tests sign in with an id
Why:      a revert of that branch would pass CI and drop every hook event on a remote machine
Refactor: the test helper `report()` in daemon-standalone-events.test.ts sends what hookLines builds (sign-in with no id), so every daemon test uses the hooks' own form
Steps:    `report()` → `hookLines(...)` lines → run the file → revert the daemon branch and see it fail
Size:     1 test file | none
When:     next change to the daemon's control socket
```
