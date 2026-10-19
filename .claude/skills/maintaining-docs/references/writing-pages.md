# Writing a page

The mechanics of a guide page. What kind of page to write and where it goes are in `SKILL.md`.

For Fumadocs itself, read its docs instead of guessing:
`npx ctx7@latest docs /fuma-nama/fumadocs "<question>"`.

## Preview

```bash
cd site/docs && npm ci && npm run dev   # http://localhost:3000/guide/
```

## File, address, sidebar

- A page's file name is its address: `(use)/machines.mdx` is `/guide/machines`, and
  `/guide/machines.md` is the same page as Markdown. Keep a name once it is published.
- A new page also goes into its folder's `meta.json`, in sidebar order, under the right
  `---Group---`. The brackets keep the folder out of the address.
- Frontmatter has a `title` and a one-line `description`. Both feed search, `llms.txt` and the
  page menu, so the description says what the page lets a person do. `sidebarTitle` shortens the
  name in the sidebar. `mode: "wide"` lets the page fill the width.
- Link to other pages as `/<name>` or `/<name>#heading`; the app adds `/guide`. Link to a heading
  when the fact lives under one, so the reader lands on it.
- `snippets/` holds text that more than one page shows on screen, pulled in with
  `<include>../snippets/roles.mdx</include>`. Use it only when the text must appear in place on
  both pages, like a table of roles. Otherwise link to the page that owns it.

## Components

Every component is available without an import. They are defined in
`site/docs/components/guide/` and registered in `site/docs/components/mdx.tsx`.

| Use | Component |
|---|---|
| A procedure | `<Steps>` / `<Step title>` |
| The same code for Linux / macOS / Windows, or Node / Python | `<CodeGroup>` around fenced blocks named after the language: ```` ```bash Linux and macOS ```` |
| Alternatives that are not code | `<Tabs>` / `<Tab title>` |
| The next pages, on a tab's or group's first page | `<CardGroup>` / `<Card title icon href>`. `icon` is a name from `ICONS` in `blocks.tsx` |
| A glossary word | `<Tooltip tip cta href>` |
| A diagram | `<Diagram name caption />`, then its text list (see `diagrams.md`) |
| A screenshot | `<Frame caption><img src="/images/…" alt="…" /></Frame>` |
| A side remark | `<Note>`, `<Tip>`, `<Warning>`: rarely; `<Warning>` only for data loss or security |
| End of every page | `<LastValidated />` |

`<Version />` prints the release the pages were last checked against. It is set once in
`site/docs/lib/shared.ts`.

In MDX, `{`, `}`, `<` and `>` outside an inline code span are code. Put placeholders and JSON in
backticks: `` `hive agents install <name>` ``.

## A prompt where it applies

A page that describes something a person sets up or does gets an `<AgentPrompt>` near the top.
It holds the exact instructions a person pastes into Claude Code, Codex or any coding agent so
it does the job on their computer. It shows **Copy prompt** and **Open in Cursor**. It ends the
prompt with a link to the page's Markdown, for the agent to read.

```mdx
<AgentPrompt description="Paste this into your coding agent to …" page="machines">{`
What to do, step by step, with the exact commands.
What to check at the end, and what to tell me.
Anything only I can do (a sudo, a DNS record, a sign-in): ask me and wait. Never type a password.
`}</AgentPrompt>
```

- It must work on its own, for an agent that has never seen this page.
- Every command, flag, setting and menu label in it exists in the code on `main`.
- A reference page gets a prompt that turns the page into work: "Using the methods on this page,
  write a script that …".
- An overview's prompt maps the reader's own setup onto the page: what runs where on their
  computer.

## Screenshots of the app

Screenshots come from `apps/desktop/scripts/docs-shots.mjs`, listed in `docs-shots.json`. Never
take them by hand: a scripted shot can be taken again after the app changes. Every image has
`alt` text that says what it shows. A screenshot shows the app. A diagram shows how the app
works. Don't use one for the other's job.
