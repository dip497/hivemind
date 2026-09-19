# The marketplace: how someone else's plugin gets in

What exists today: `plugins/index.json` in this repository, every file pinned by SHA-256, an
entry that may carry `source` so a plugin's files live in its author's repository, and a
review dialog that names what an agent does before it is installed. What does not exist:
any way for a person who is not us to get listed, and anything to look at before installing.

## What the field actually does

Five ecosystems, checked rather than remembered (September 2026).

| | Submission | Preview before install | Install | Integrity |
|---|---|---|---|---|
| **skills.sh** | directory site; a skill is a GitHub repo | listing page | `npx skills add <owner>/<repo>` — a copied command | none |
| **Claude Code** | anyone publishes `.claude-plugin/marketplace.json` in a repo; `/plugin marketplace add owner/repo` | `/plugin` browser (Discover / Installed / Marketplaces / Errors / Stats); entry carries `displayName`, `description`, `version`, `author`, `homepage`, `repository`, `license`, `keywords`, `category`, `tags` | in-app | reserved marketplace names, so nobody can look official; `claude plugin validate .` for authors |
| **Obsidian** | pull request adding an entry to `community-plugins.json` (name, author, description — used for search) | the detail page **fetches `manifest.json` and `README.md` live from the author's repository** | in-app; files come from the author's GitHub *release* tagged with the manifest version | version pinning; no hashes |
| **Raycast** | pull request into one monorepo, human review | detail screen with **up to six screenshots** (three recommended), README, commands, categories | "Install Extension" button on the web store | central review |
| **Herdr** | **none — a GitHub topic.** Repositories tagged `herdr-plugin` whose manifest parses are listed automatically | repository cards, sorted by popularity / activity / newest | `herdr plugin install owner/repo` | explicitly none; "automatic and unreviewed" |

Read together they agree on four things. The index holds **a pointer and a little metadata**,
never the code. The preview is **fetched from the author**, not stored centrally. Install is
addressed as **`owner/repo`**. And every one of them gives authors **a validator to run
before submitting** — the single most common piece of tooling in the table, and the one we
did not have.

They disagree on exactly one axis, and it is the interesting one: **who decides what is
listed.** Raycast and Obsidian spend human review per plugin. Herdr spends none and says so
out loud. Claude Code sidesteps it — anyone can publish a marketplace, and the user chooses
which to add.

## What we have that none of them do

Our agents are **data**. Not sandboxed code, not reviewed code — a manifest that declares
what it launches. That means the question "what will this do to my machine?" has an exact
answer we can compute, and `agentDisclosures()` computes it: the command it runs, the
directory it reads, the listing command it executes, whether it reaches the control plane.

So we can be closer to Herdr's end of the axis than Raycast's without being reckless, as long
as the review screen keeps doing the work review would have done. The rule already holds
where it matters most: **an agent added automatically, with nobody reading it, may have no
disclosures at all**. Everything else waits for a person.

We also pin every file by hash, which Obsidian, skills.sh and Herdr do not.

## The plan

**1. Discovery is a GitHub topic, and a bot does the work.** An author publishes a repository
with `agent.yaml` in it and tags it `hivemind-plugin`. A scheduled Action searches the topic,
fetches each manifest, runs the same untrusted validation a user's machine runs, computes
the hashes, and regenerates `index.json`.

This is Herdr's discovery with Obsidian's pointer model and our hashes kept — because the bot
re-hashes on every crawl, automatic listing and hash pinning stop being a trade-off. Nobody
in the table gets both; we can, because our plugins are small enough to fetch in full.
A plugin that stops validating drops off the list by itself, which is the maintenance
Raycast and Obsidian pay people to do.

Curated entries stay curated: first-party plugins keep their place in the index and the UI
says which is which. "Listed" must never read as "vetted".

**2. `hive agents validate <dir>` — done.** Every ecosystem in the table has this and it is
where an author starts. It runs the real untrusted validation and then prints *what a user
will be told*: the command, whether it is a worker, its disclosures, and the warnings that
are not errors — an asset it names but does not ship, a `bin` that makes it ineligible for
auto-install, a name that is already Hivemind's.

**3. Preview, in order of value per unit of work.**

- **The agent's own icon.** It already exists, already validated, already safe to render — and
  the catalog list currently shows a generic glyph for everything. Put it in the entry.
- **`readme`** — a path *inside the plugin's own files*, so it is hash-pinned like everything
  else. This is Obsidian's move without Obsidian's trust gap: they fetch the README live from
  a repository that can change after listing; ours cannot change without failing its hash.
- **`screenshots`** — the same, and the reason views need them: a view is a picture, and
  today its listing is a line of text. Six maximum, as Raycast found.

**4. Install from a link, later.** `hivemind://install?…` is what Raycast and VS Code do, and
it means any web page can ask the app to install something. That is survivable only because
install goes through the review dialog — which it does — but the boring version earns most of
it: `hive agents install <owner>/<repo>` and a copy button. Add the scheme when someone asks.

**Not this:** a registry service. It needs hosting, moderation, accounts and an on-call
person, and a file in a git repository does the same job for the first thousand plugins.

## What blocks all of it

`plugins/index.json` is not on `main`, so the default index 404s and Browse is empty. Every
line above assumes a catalog that resolves. That merge comes first.
