# Writing the Hivemind guide

This folder is the Hivemind user guide, built with [Mintlify](https://mintlify.com). Pages are
MDX files with YAML frontmatter; `docs.json` holds the navigation, brand and page menu. The
repository's `docs/` folder is design notes, not this guide.

For Mintlify itself (components, `docs.json` settings), read its docs rather than guessing:
`npx ctx7@latest docs /mintlify/docs "<question>"`, or the MCP server
`https://www.mintlify.com/docs/mcp`.

## Preview and check

```bash
cd guide
npx mint@latest dev            # http://localhost:3000
npx mint@latest broken-links   # must pass before you commit
npx mint@latest validate       # must pass before you commit
```

## Every page

- Frontmatter has a `title` and a one-line `description`. Both feed search, `llms.txt` and the
  page menu, so the description says what the page lets a person do.
- A page's file name is its address: `machines.mdx` is `/machines`. Keep a name once published;
  the old site sends `/guide/<name>` to `/<name>`. A new page goes into `docs.json` too.
- Link to other pages as `/<name>` or `/<name>#heading`.

## A prompt where it applies

Where a page describes something a person sets up or does, put a `<Prompt>` near the top: the
exact instructions a person pastes into Claude Code, Codex or any coding agent so it does the job
on their computer.

```mdx
<Prompt description="Paste this into your coding agent to …" actions={["copy","cursor"]}>
What to do, step by step, with the exact commands.
What to check at the end, and what to tell me.
Anything only I can do (a sudo, a DNS record, a sign-in): ask me and wait. Never type a password.
</Prompt>
```

- Self-contained: it works for an agent that has never seen this page.
- Every command, flag, setting and menu label in it exists in the code on `main`.
- A reference page gets a prompt that turns the page into work ("Using the methods on this page,
  write a script that …").
- In MDX, `{`, `}`, `<` and `>` outside an inline code span are code. Put placeholders and JSON
  in backticks: `` `hive agents install <name>` ``.

## Plain words

- Write for a newcomer. Use the words the app shows (**Settings ▸ Plugins**, **Layers**), in bold
  when they are on screen. No internal names, ticket numbers or abbreviations a user never sees.
- Short sentences, active voice, "you". One idea per sentence.
- Say only what the code does today. Something removed leaves no trace: no "was", no "no longer".
- Use `<Steps>` for a procedure, `<CodeGroup>` for Linux / macOS / Windows or Node / Python
  variants, `<CardGroup>` on a section's first page, `<Note>` and `<Warning>` rarely.

## Pictures

Diagrams are SVG files in `images/`, shown with `<Frame caption="…"><img src="/images/x.svg" alt="…" /></Frame>`,
or Mermaid code blocks for simple flows. Every image has `alt` text that says what it shows.

## One address for the docs site

The site's own address lives once, in `snippets/docs-site.mdx` (`docsUrl`). Anything that names
the docs site, such as the MCP server address, reads it from there.
