---
name: maintaining-docs
description: How to write and structure the Hivemind user guide (guide/, built by site/docs, served at /guide) so it stays short, plain, correct and readable by agents. Covers where a page goes and what kind of page it is, one home per fact, the copy rules, diagrams drawn as code (sizes, contrast, phone layouts, the text list under each), the Markdown and llms.txt output, and the checks before a PR. Use it whenever you add, edit, merge or move a page in guide/, rewrite docs after a code change, draw or change a diagram, or review a docs PR, even if the task only says "update the docs" or "document this".
---

# Maintaining the docs

The guide is the pages in `guide/`, built by the Fumadocs app in `site/docs/` and served at
https://hivemind.griiken.com/guide. `docs/` at the repo root holds engineering notes. Those notes
are not the guide and are never published.

A good page does three things. It answers one question for a newcomer. It says each fact once.
It reads as well to an agent fetching the Markdown as to a person in a browser. Everything below
serves those three.

## 1. Where a page goes

Each folder in brackets is a tab: `(get-started)`, `(use)`, `(concepts)` (shown as **How it
works**), `(extend)`, `(api)`, `(reference)`, `(help)`. Its `meta.json` lists pages in sidebar
order, and `---Name---` starts a group. Pick the tab by the page type:

| Page type | Answers | Tab | Shape |
|---|---|---|---|
| Overview | What is this, and how do the parts fit? | first page of a tab or group | one diagram, its list, a few lines, cards to the next pages |
| Component | What does this one part do, and what does it talk to? | `(concepts)` › Components | diagram, list, then only what the diagram can't show |
| Concept | What is this idea (workspace, agent state, trust)? | `(concepts)` › Core concepts | definition first, then the rules |
| How-to | How do I get X done? | `(use)`, `(extend)`, `(get-started)` | `<AgentPrompt>`, then `<Steps>`, then what to check |
| Reference | What is every flag, setting, method, field? | `(reference)`, `(api)` | complete tables, no story |
| Help | Something is wrong, or I need to install or update | `(help)` | symptom → cause → fix |

If a page needs two types, it is two pages. A how-to that starts explaining internals links to
the component page. A component page that starts listing every flag links to the reference.

Mechanics of a new page are in [references/writing-pages.md](references/writing-pages.md):
file name and address, frontmatter, `meta.json`, links, components.

## 2. One home per fact

Each fact lives on exactly one page. Every other page that needs it links there in one line.

- **Find the home before you write.** Run `grep -rn "<the fact's key words>" guide/`. The page
  type decides who owns it. How it works owns how a part works. Use and Extend own how to do
  something with it. Reference owns complete lists. Help owns fixes.
- **Link, don't restate.** Write "Your server relays it: see [How devices connect](/how-devices-connect#encrypted-end-to-end)."
  Do not repeat the paragraph. A one-clause reminder is fine; a second explanation is not.
- **The list under a diagram is the explanation.** The prose on that page adds only what the
  diagram can't show. It never walks the arrows again.
- **Merge overlapping pages.** If two pages cover the same ground, keep the one whose type fits.
  Move anything unique into it and turn the other into links, or delete it. A deleted page goes
  out of `meta.json`. Fix every link to it: check-links finds the ones you missed.
- **Say it in the PR.** The PR body lists each duplicate you removed and its single home.

## 3. Correct before anything else

- Say only what the code on `main` does today. Check every command, flag, setting, menu label and
  path in the code before you write it, and keep `path:line` notes for the PR.
- When a design note in `docs/` disagrees with the code, the code wins. List each disagreement
  in the PR body, so someone fixes the note or the code.
- Something removed leaves no trace: no "was", no "no longer", no "used to".
- A page's own claims about the docs (counts, "every page has…") are facts too. Check them.

## 4. Copy rules

- Plain words a newcomer reads without help. Use the words the app shows, in bold when they are
  on screen (**Settings ▸ Plugins**). No internal names, ticket numbers or abbreviations a user
  never sees.
- Short sentences, active voice, "you". One idea per sentence. Fewer words wins: cut a sentence
  the page works without.
- Lead lines (a page's first line, a description, a card) lead with what you get. Hivemind's
  lead is **your agents build the workspace they work in**: your own views, tools and widgets,
  and a workspace that agents and your programs drive.
- Never lead with "waiting on you" or attention-management framing. Never state a count of
  agents ("run 10 agents").
- No pill or chip badges, no decorative labels, no emoji. A heading or a bold word does the job.
- Each component (`<Note>`, `<Tip>`, `<Warning>`, tabs, cards) only where it earns its place.
  `<Warning>` is for data loss or security.

## 5. Diagrams

Diagrams are drawn as code in `site/scripts/diagrams/` and saved as `guide/images/<name>.svg`.
A page shows one with `<Diagram name="<name>" caption="…" />`, inline, so its text is selectable
and its colours follow the light or dark theme. Only a diagram that shows a mechanism earns a
place: parts and what flows between them, a sequence, or states. Never use a decorative one.

The rules (details, numbers and the drawing API in [references/diagrams.md](references/diagrams.md)):

- **No Mermaid, no raster, no hand-written SVG.** Every diagram comes from the builder, so one
  change to the style changes all of them.
- **Type size:** labels at least 12px, box titles 15px, as rendered on the page. A diagram is at
  most 800 wide and drawn 1:1, so drawn size is page size. When it doesn't fit, cut words
  (shorter subtitles and wire labels) or reflow. Never shrink the art.
- **Contrast:** every text colour at least 4.5:1 on every fill it sits on, in both themes.
- **Phones:** a wide diagram scrolls inside its frame at full size. An overview that people must
  read on a phone gets a `<name>-phone` layout about 320 wide, stacked top to bottom. `<Diagram>`
  swaps it in on small screens.
- **A text list right under every diagram:** `- **A** → **B**: what goes, and how.` It is what the
  Markdown copy, `llms.txt` and screen readers get. It says what the diagram says, not what it
  looks like.
- **Every fact in a diagram traces to code**, like any other fact on the page.
- **Check geometry** with diagram-design's `verify-geometry.py`: no label over a box, no wire
  through a label, nothing outside the frame. Then look at the PNGs.

## 6. Readable by agents

Every page is built twice: as HTML for people, and as Markdown for agents. Keep both working.

- `/guide/<name>.md` is the page as Markdown. `llms.txt` lists every page with its description.
  `llms-full.txt` is every page in one file. All come from `site/docs/lib/source.ts`. A
  `<Diagram>` becomes a link to its SVG plus your text list, which is why the list matters.
- Each page's **Copy page** and **Open** menu comes free. Don't rebuild it in the page. The agents
  that menu and every prompt box offer are one list, in `site/docs/lib/open-in.tsx`.
- A how-to page gets an `<AgentPrompt>` near the top: the instructions a person pastes into their
  coding agent to do the job. It must work for an agent that never saw the page. The format and
  rules are in [references/writing-pages.md](references/writing-pages.md#a-prompt-where-it-applies).
- An overview that agents act on gets a **For agents** section with a table: part → the
  `hive ctl` commands → the API methods (see `guide/(concepts)/architecture.mdx`). When a
  command or method is added, renamed or removed, update that table and the reference page in
  the same PR.
- The description in frontmatter feeds search and `llms.txt`. Make it say what the page lets you
  do, in one line.

## 7. Before the PR

Run these from the repo root, one at a time on a busy machine (`nice -n 10`). The commands are in
[references/checks.md](references/checks.md).

1. `npm run diagrams` in `site/`, if any diagram changed. Commit the `.svg` and the `html/` page.
2. `verify-geometry.py` on `guide/images/*.svg`: 0 findings.
3. The site build: the guide must compile.
4. `node scripts/check-links.mjs` in `site/`: every link, picture, `#heading`, Markdown copy, Open
   menu and prompt-box link, `llms.txt` entry and redirect on the built site leads somewhere.
   After a deploy, `node scripts/check-links.mjs --live https://hivemind.griiken.com` checks the
   real site, external links too.
5. Screenshots of every page you changed at 1440 and 390, light and dark. **Look at them.** Check
   the diagram text is readable, nothing scrolls the page sideways, and the dark theme has no
   unreadable grey.

A PR body lists what it moved or merged (and each fact's home), any code-vs-design
disagreements, and the screenshots you looked at. Docs that describe a code change go in the
same PR as the code.

**Merging to `main` deploys the site** (`.github/workflows/site.yml` runs on `site/**` and
`guide/**`). Do not merge a docs PR yourself unless you were told to.
