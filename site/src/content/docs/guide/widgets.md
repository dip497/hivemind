---
title: Widgets
description: Small live cards on the board, drawn by a few lines of your code.
---

A widget is a small live card: a counter, a meter of busy agents, a sticky note. Widgets float
above every view; drag each where you want it. Which widgets there are and what they hold is saved
with the workspace; where they sit is yours alone.

## Make one

```bash
hive widgets new counter      # ./counter: widget.json, widget.js, hive.d.ts, PROMPT.md
hive widgets install counter
```

Then **Add → Counter** places it. Hover it for its options (the gear) and to remove it.

```json
{
  "name": "Counter",
  "icon": "icon.svg",
  "options": [{ "id": "step", "label": "Step", "type": "number", "default": 1 }]
}
```

```js
const draw = () => hive.render({ type: "stack", children: [
  { type: "number", value: hive.state?.n ?? 0, label: "presses" },
  { type: "button", label: "Press", action: "inc" },
] });
hive.on("start", draw);
hive.on("action", (a) => {
  if (a === "inc") { hive.setState({ n: (hive.state?.n ?? 0) + (hive.options.step ?? 1) }); draw(); }
});
```

`options` uses the settings fields every plugin uses (`boolean`, `number`, `text`, `choice`), each
with a `default`. What someone sets is shared with everyone in the workspace.

## What your code gets

| | |
|---|---|
| `hive.render(tree)` | draw the widget |
| `hive.state`, `hive.setState(value)` | what it keeps, saved in the workspace |
| `hive.options` | its options, as set (else their defaults) |
| `hive.on("options", fn)` | the person changed its options |
| `hive.notify(text)` | a desktop notification |
| `hive.moveTo({ x, y }, { over })` | move its card: `x`, `y` from 0 to 1 across the screen (`y: "bottom"`), over `over` ms; every viewer animates it |
| `hive.spot` | where it last moved to |
| `hive.on("click", fn)` | its card was clicked (not on a button) |
| `hive.on("start", fn)` | it was placed or the app opened |
| `hive.on("action", fn)` | one of its buttons was pressed; `fn` gets the button's `action` |
| `hive.on("hm", fn)` | `hive.hm`'s values arrived or changed |
| `hive.hm` | the workspace, as a view sees it: see below |

It runs in a worker: no network, no files. What it draws and its state are each up to 16 KB.

## What it can draw

| Node | Fields |
|---|---|
| `stack`, `row` | `children` |
| `text` | `text`, `size: "large"`, `muted: true` |
| `number` | `value`, `label` |
| `meter` | `value`, `max`, `label` |
| `button` | `label`, `action` |
| `image` | `src` (an image in its folder), `w`, `h` |
| `sprite` | `src` (a sheet of frames), `frameW`, `frameH`, `row`, `frames`, `fps`, `scale`, `flip` |

Images (`.png`, `.gif`, `.webp`, `.jpg`, `.svg`, up to 1 MB) go in the widget's folder.
`"chrome": "none"` drops the card, for a pet that walks the screen.

## Without code

A widget can be data and a drawing alone. The built-in Sticky note, Checklist and Text are made
this way:

```json
{
  "name": "Sticky note",
  "placement": "board",
  "size": { "w": 220, "h": 180 },
  "options": [{ "id": "color", "label": "Colour", "type": "choice",
                "values": ["yellow", "pink", "blue"], "default": "yellow" }],
  "draw": { "type": "stack", "fill": true, "tint": "$options.color",
            "children": [{ "type": "textarea", "placeholder": "Write something" }] }
}
```

`placement: "board"` pins it to the canvas, moving with its frame. `input`, `textarea` and `list`
are what people write in; two people typing at once merge, and ⌘Z takes it back.

## Read and drive the workspace

`hive.hm` is the same client a view has ([Write a view](../extension-authoring/)), held to the
permissions `widget.json` asks for:

```json
{ "name": "Agents at work", "permissions": ["workspace:spawn", "workspace:prompt"] }
```

```js
hive.hm.onEvents(["turn", "needsInput"], (e) => hive.notify(`${e.kind} in ${e.tileId}`));
hive.on("hm", draw);   // hive.hm's values arrived or changed
```

An agent can run commands the widget declares in `"commands"`, answered with
`hive.hm.onCommand(name, handler)`:

```sh
hive ctl plugin call @dip497/progress add '{"text":"Run the tests"}'
```

## Where it runs

<figure class="diagram" style="--min:600px">
  <div><img src="../../diagrams/widgets-runner.svg" width="640" height="330" alt="One window runs widget.js: the first of your own windows with the workspace open to ask. What it draws goes live to guests' windows, your other windows on any of your devices, and your phone through a widgets view; a press from any of them goes back to that window. Guests can press only if they can edit the board. Nothing it draws is saved." /></div>
  <figcaption>One window runs a widget; everyone sees it</figcaption>
</figure>

The first of your own windows with the workspace open runs it. Nobody else's computer runs your
code. A guest who can edit the board can press its buttons. On your phone, a view that shows
widgets draws them (`hive views install @dip497/widgets`).

## Share it

```json
{ "id": "@you/counter", "name": "Counter", "version": "1.0.0", "icon": "icon.svg" }
```

```sh
hivehub publish widgets/counter
hive widgets install @you/counter     # what others run
```

On [HiveHub](https://hivehub.griiken.workers.dev/), as `@dip497/<name>`: `progress` (steps agents
tick off), `waiting-on-you`, `agent-pulse`, `issue-burndown`, `ci-light`, `test-meter`,
`spend-today`, `focus-timer`, `launchpad`, `dog`.
