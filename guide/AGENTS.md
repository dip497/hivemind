# Writing the Hivemind guide

This folder holds the pages of the Hivemind user guide, served at
https://hivemind.griiken.com/guide. They are MDX files with YAML frontmatter. The app that builds
them is in `site/docs/` ([Fumadocs](https://www.fumadocs.dev) on Next.js, exported as static
files); the website copies the result to `/guide`. The repository's `docs/` folder is design
notes, not this guide.

For Fumadocs itself, read its docs rather than guessing:
`npx ctx7@latest docs /fuma-nama/fumadocs "<question>"`.

## Preview and check

```bash
cd site/docs && npm ci && npm run dev   # http://localhost:3000/guide/
cd site && npm ci && npm ci --prefix docs && npm run build && node scripts/check-links.mjs
```

The build fails on a page that does not compile; the link check fails on a link or picture that
leads nowhere. Both must pass before you commit; CI runs them too.

## Where a page goes

- Each folder in brackets is a tab at the top: `(get-started)`, `(use)`, `(concepts)`, `(extend)`,
  `(api)`, `(reference)`, `(help)`. Its `meta.json` lists the pages in sidebar order, and
  `---Name---` starts a group. The brackets keep the folder out of the address.
- A page's file name is its address: `(use)/machines.mdx` is `/guide/machines`, and
  `/guide/machines.md` is the same page as Markdown. Keep a name once published. A new page goes
  into its folder's `meta.json` too.
- Frontmatter has a `title` and a one-line `description`. Both feed search, `llms.txt` and the
  page menu, so the description says what the page lets a person do. `sidebarTitle` shortens the
  name in the sidebar; `mode: "wide"` lets the page fill the width.
- Link to other pages as `/<name>` or `/<name>#heading`; the app adds `/guide`.
- `snippets/` holds text shared by pages, pulled in with `<include>../snippets/roles.mdx</include>`.

## A prompt where it applies

Where a page describes something a person sets up or does, put an `<AgentPrompt>` near the top:
the exact instructions a person pastes into Claude Code, Codex or any coding agent so it does the
job on their computer. It shows **Copy prompt** and **Open in Cursor**, and ends the prompt with
the page as Markdown for the agent to read.

```mdx
<AgentPrompt description="Paste this into your coding agent to …" page="machines">{`
What to do, step by step, with the exact commands.
What to check at the end, and what to tell me.
Anything only I can do (a sudo, a DNS record, a sign-in): ask me and wait. Never type a password.
`}</AgentPrompt>
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
- Use `<Steps>` / `<Step title>` for a procedure, `<CodeGroup>` around code blocks for Linux /
  macOS / Windows or Node / Python variants (a block's name follows its language:
  ```` ```bash Linux and macOS ````), `<Tabs>` / `<Tab title>`, `<CardGroup>` / `<Card>` on a
  section's first page, `<Tooltip tip cta href>` for a word from the glossary, and `<Note>`,
  `<Tip>` and `<Warning>` rarely. Every component is available without an import; they are
  defined in `site/docs/components/guide/`.
- End a page with `<LastValidated />`. `<Version />` prints the release the pages were last
  checked against, set once in `site/docs/lib/shared.ts`.

## Pictures

Diagrams are drawn as code in `site/scripts/diagrams/` (see its README) and saved as
`images/<name>.svg`. Show one with `<Diagram name="<name>" caption="…" />`: it sits inline, so its
text is selectable and its colours follow the light or dark theme. Right under it, list its boxes
and arrows in a few short lines. That list is the diagram for the Markdown copy, `llms.txt` and
any reader who cannot see it, so the page's prose does not say it again.

Screenshots of the app come from `apps/desktop/scripts/docs-shots.mjs`, listed in `docs-shots.json`,
and go in `<Frame caption="…"><img src="/images/…" alt="…" /></Frame>`. Every image has `alt` text
that says what it shows.

## One home per fact

Each fact lives on one page. Another page that needs it links there in one line. The pages under
**How it works** own how the parts work; the other tabs own how to do things with them.
