# What an agent says (0.1)

An agent's words reach the person's phone as markdown (`agents.md` "Conversation"; a plan's text
in `needs.md`). The phone's core reads it once, the same way for every app, and hands the app its
blocks to draw. The cases in `../conformance/markdown.json` decide whether a reader follows this.

## Read

CommonMark, with GitHub's tables, strikethrough (`~~`) and task lists (`- [ ]`, `- [x]`). Nothing
else is read: no footnotes, maths or heading attributes.

- **Raw HTML is text.** A tag, inline or a block of it, is kept as the characters written and drawn
  as such: never parsed, never run.
- **A line break inside a paragraph is kept** as a line break, soft or hard.
- **A fence not closed yet** is code to the end of the text: the agent is still saying it.

## Links

A link is one only to an `https://` address (the scheme in any case) with a host. Anything else
(`http:`, `javascript:`, `data:`, `mailto:`, a relative path) keeps its words as text, with nothing
to tap.

An `https://` address written bare in text is a link too, when it starts a word: from `https://` to
the first space or `<`, less the punctuation that ends a sentence (`. , : ; ! ? ' "`) and a `)` or
`]` the address did not open. Not in code.

An image is drawn by its words (its alt text; its address when it has none), marked as an image,
and is a link when its address is https. Nothing is fetched to draw it: an address in what an agent
says is never loaded without the person tapping it.

## Blocks

The text is a list of blocks, in order. Each is one of:

| `is` | Fields |
|---|---|
| `paragraph` | `runs` |
| `heading` | `level` (1–6), `runs` |
| `code` | `text`, as written, without its last line break; `language`, the first word of its fence, when it names one |
| `rule` | none |
| `table` | `align`, each column's (`none`, `left`, `center`, `right`); `head`, its head row's cells; `rows`, each row's cells. A cell is a list of runs; a row with fewer cells than the head has them empty |

and says where it is:

- `depth`: how many lists it is in (0 when none; absent when 0).
- `quote`: how many quotes it is in (absent when 0).
- `marker`: on the first block of a list item, what starts it: `{"is":"bullet"}`,
  `{"is":"number","n":3}` (its number, counted from where its list starts), or
  `{"is":"task","done":true}`. A list item with nothing in it is an empty paragraph with its marker.
  The item's other blocks have the same `depth` and no marker.
- `rtl`: on a paragraph or heading whose first letter is written right to left (Hebrew, Arabic,
  Syriac, Thaana, N'Ko and the other scripts written so; absent when not). Digits, punctuation and
  spaces before it decide nothing, as Unicode finds a paragraph's direction (UAX #9, P2). Drawn
  from the right; a block with no such letter first, from the left.

A run is text of one style: `text`, and each of `strong`, `emphasis`, `strike`, `code`, `image`
that holds (absent when not), and `link`, an https address, when it is one. Styles nest: a run
carries every style it is inside. Neighbouring runs of the same style are one, but an image is
always a run of its own.

## Drawing

An app draws the blocks one under the other, each in its own direction (a page may let the
browser find it, `dir="auto"`, which follows the same rule and finds a table cell's too): a heading
larger the higher its level, code in a monospace face under its language, not wrapped; a block in
lists set in by its depth after its marker (a bullet, the number and a dot, or a box ticked or not
that cannot be ticked there); the blocks of a quote set in after a bar, a quote in a quote
further; a table's cells in their columns, aligned as each says. Text is drawn as text only: no
part of it is ever read as markup again. A link opens its address outside the app (a browser's
other tab) when tapped.
