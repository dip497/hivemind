# Dog

A widget that moves. Biscuit lives along the bottom of your screen, with no card around it, and
keeps an eye on your agents:

- **An agent starts waiting on you:** it barks, sends one notification, then walks to the right
  edge and sits there wagging until you answer.
- **A turn finishes:** it jumps for joy.
- **Every agent idle for a minute and a half:** it curls up and naps. Any agent getting to work wakes it.
- **Click it:** if someone is waiting, it takes you to that agent; otherwise it sits and wags.

It never moves faster than a walk: crossing the whole screen takes it 14 seconds.

```bash
hive widgets install examples/widgets/dog    # then add it from the toolbar's Add menu
hive ctl plugin open widget:@dip497/dog        # or let an agent place it
hive ctl plugin call @dip497/dog status        # what it is doing, and who it waits for
```

Options: its **name**, and **quiet**, which keeps the bark but drops the notification. It asks for
no permissions: it reads the agents' states through `hive.hm` and goes to a tile with
`focusTile`, which needs none.

`dog.png` is one sprite sheet, 6 frames of 32 px a row: walk, sit (wagging), sleep (breathing),
bark and jump. Under reduced motion the app holds each row on its first frame.

## How it was made

Built by a coding agent (Claude) from the widget contract (`hive.d.ts` and the
[Widgets guide](../../../site/src/content/docs/guide/widgets.md)); the sprite sheet was drawn by a
short script, pixel by pixel. Its behaviour test is `packages/hive-core/src/showcase-widgets.test.ts`,
which runs `widget.js` with the same worker prelude the app uses.
