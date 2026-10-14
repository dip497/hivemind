# The phone's look (2026-10-15)

Status: accepted (2026-10-15). One look for the three phone surfaces: the phone page
(`crates/hive-web/www`), the Android app (`apps/android`) and, later, the iOS app (`apps/ios`).
Each surface follows this file; a change to the look changes this file first.

## Why

The person asked for the phone to look like the agent apps people already use on a phone, and for
the page, Android and iOS to look the same. Two were studied:

- Codex in the ChatGPT app: [its phone docs](https://learn.chatgpt.com/docs/mobile) (a live HTML
  mock of the phone screens, with exact labels and colours),
  [remote connections](https://learn.chatgpt.com/docs/remote-connections) and
  [the launch post](https://openai.com/index/work-with-codex-from-anywhere/).
- Claude Code in the Claude app: [mobile](https://code.claude.com/docs/en/mobile),
  [remote control](https://code.claude.com/docs/en/remote-control),
  [the web quickstart](https://code.claude.com/docs/en/web-quickstart),
  [the changelog](https://code.claude.com/docs/en/changelog) and
  [Simon Willison's write-up](https://simonwillison.net/2025/Oct/20/claude-code-for-web/).

Both share the same shape: a list, then one task; light chrome; rows with a small status mark
instead of badges; approvals and questions as cards, in the list and in the task; the person's
words in a subtle bubble and the agent's as plain text; tool calls as one-line rows; a rounded
composer pinned at the bottom whose send becomes Stop while the agent works; colour only for the
diff and for status. We take Codex's neutral greyscale, because it has no brand accent to fight the
person's own frame colours and works the same in light and dark. We keep what neither has: each
tile's last line under its name, which tells the person what an agent is doing without opening it.

## The look

### Tokens (light / dark)

| What | Light | Dark |
| --- | --- | --- |
| Background | `#ffffff` | `#191919` |
| Raised surface: cards, sheets, the composer | `#f7f7f7` | `#212121` |
| Selected chip, pressed | `#ededed` | `#2b2b2b` |
| Text | `#171717` | `#f4f4f4` |
| Secondary text | `#5d5d5d` | `#a3a3a3` |
| Tertiary text | `#8f8f8f` | `#6e6e6e` |
| Hairline | `#e5e5e5` | `#2e2e2e` |
| Primary button | `#171717`, white text | `#f4f4f4`, `#171717` text |

Colour is only for meaning:

| Meaning | Light | Dark |
| --- | --- | --- |
| Waiting: it needs the person | `#b26a00` | `#e8a64a` |
| Failed | `#d73a49` | `#f0707b` |
| Done | `#258b20` | `#5fbf57` |
| Diff + / − | `#258b20` / `#d73a49` | `#5fbf57` / `#f0707b` |

Working is a neutral spinner, not a colour. The person's chosen accent, where a surface uses one,
stays on their own avatar or dot, never on chrome.

### Type and shape

- Geist for text, JetBrains Mono for code, commands and paths.
- Titles 600 with -0.02em letter-spacing; body 400; rows one line each.
- Pills (999px) for buttons and chips; 16–20px radius for cards and the composer.
- Hairline borders; almost no shadows, except a soft one on floating cards and sheets.

### Components

1. **Header**: the screen's name on the left, icon buttons on the right (search, overflow). No
   coloured app bar.
2. **Machine chips**: a horizontal scrolling row, `All | <machine> …`, each machine with an online
   dot (green when reached, hollow grey when not) where the surface knows it; the selected chip
   filled with the selected colour. Shown only with more than one machine.
3. **Rows**: the title on one line, and an optional grey second line, the tile's last line. Status
   is a small trailing mark: a spinner while it works, an amber dot while it waits on the person, a
   red dot when it failed, nothing when idle or done. Time ago in tertiary text. No coloured state
   badges or pills in rows.
4. **Needs-you card** (Home and the agent's screen): a raised card. A small grey label
   ("Permission", "Question"), the question in body text, the command in mono with a terminal
   glyph; full-width pill buttons stacked: the primary **Allow** (solid), then the other answers
   the agent offers, as outlined pills. Only answers the data has: nothing is invented. Where a
   surface lets the person deny with a reason, a hairline, then a "Tell it what to do instead" field
   and an outlined **Deny**. A question's options are outlined pills in the same card.
5. **Agent screen**: the person's messages in a subtle raised bubble on the right; the agent's text
   plain and full width, no bubble, no avatar; tool calls as one-line grey rows (tool name and what
   it is about), unfolding where the surface unfolds them. Header: back, the agent's name and its
   state in a word, the terminal as an icon or a segmented control. **Composer**: a rounded raised
   card pinned at the bottom, + for photos on the left where the surface sends photos, a round ↑
   send on the right that becomes ■ Stop while the agent works.
6. **Start**: what starts where (agent, folder, machine) on top, a large prompt field ("What should
   it do?"), + for photos, a round ↑ to start.
7. **Diff**: a header "Changes · N files +a −b" (green and red), file rows with each file's + and −,
   hunks in mono with line numbers and faint row tints.
8. **Devices**: rows with an online dot and when each was last seen, where the surface knows it.
   Pairing unchanged.
9. **Tabs**: the surface's own tabs, in its order, quiet: icon and label, the selected one in the
   text colour, the others tertiary, no filled indicator.

Light and dark are both first-class: every screen is checked in both.
