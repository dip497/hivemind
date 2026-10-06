---
title: Widgets
description: Small live boxes on the board, drawn from what your code renders.
---

A widget is a box on the board whose content your code draws: a counter, a meter of busy agents,
a reminder. Everyone who sees the board sees it, guests included, without installing anything:
your code runs on the machine that keeps the workspace, and the board stores what it drew.

## Make one

A widget is a folder in your profile's `widgets` folder (on Linux
`~/.config/hivemind/widgets/<name>/`) holding two files:

`widget.json`

```json
{ "name": "Counter", "w": 220, "h": 140 }
```

`widget.js`

```js
const draw = () => hive.render({ type: "stack", children: [
  { type: "number", value: hive.state?.n ?? 0, label: "presses" },
  { type: "button", label: "Press", action: "inc" },
] });
hive.on("start", draw);
hive.on("action", (a) => {
  if (a === "inc") { hive.setState({ n: (hive.state?.n ?? 0) + 1 }); draw(); }
});
```

Restart Hivemind, then **Board → Counter** puts it on the board.

## What your code gets

| | |
|---|---|
| `hive.render(tree)` | draw the widget |
| `hive.state`, `hive.setState(value)` | what it keeps, saved in the workspace |
| `hive.notify(text)` | a desktop notification |
| `hive.on("start", fn)` | it was placed or the app opened |
| `hive.on("action", fn)` | one of its buttons was pressed; `fn` gets the button's `action` |
| `hive.on("agents", fn)` | the agents' states changed; `fn` gets `{ tileId: state }` |

It runs in a worker: no network, no files, nothing of the app but `hive`. `render` and `state`
are each kept up to 16 KB of JSON; larger is dropped.

## What it can draw

| Node | Fields |
|---|---|
| `stack`, `row` | `children` |
| `text` | `text`, `size: "large"`, `muted: true` |
| `number` | `value`, `label` |
| `meter` | `value`, `max`, `label` |
| `button` | `label`, `action` |

Buttons work on the machine that runs the widget; a guest sees the widget but its buttons do
nothing yet.
