# CLAUDE
<!-- hyperresearch:start -->
## Research Base (hyperresearch) — Today is 2026-05-17

**CLI path: `/home/dipendra-sharma/projects/hivemind/.venv/bin/hyperresearch`** — use this exact path for every hyperresearch command. It may not be on your system PATH.

**Paths in this document are relative to your current working directory**, not to the CLI binary's location. Use `research/notes/final_report_<vault_tag>.md` (not a prefix with the binary path) when you save files.

This project uses hyperresearch as an agent-driven research knowledge base. The `research/` directory contains markdown notes collected from web sources and original research. Append `--json` to any command for structured output.

### How to do research

**Run a research session with `/hyperresearch <query>`.** This invokes the V8 16-step pipeline. The entry skill at `.claude/skills/hyperresearch/SKILL.md` is a thin ROUTER. The 16 step procedures live in their own skills (`hyperresearch-1-decompose` through `hyperresearch-16-readability-audit`) and are loaded fresh into context via the `Skill` tool when each step runs. This solves V7's context-compaction problem: each step's procedure lands in context only when needed. Read the entry skill before you start a research session; it explains the chain mechanics.

Step 1 classifies the query into one of two tiers (`light` or `full`) and the rest of the pipeline scales accordingly — short bounded queries skip the depth investigations, critics, and patcher (~30-40 min); argumentative deep-research queries run all 16 steps with adversarial review (~1.5-2.5 hours).

**Do NOT use WebFetch for source pages** — use `/home/dipendra-sharma/projects/hivemind/.venv/bin/hyperresearch fetch` instead. The skill files explain when to fetch vs. search.

### What the skill files own

The skill files own everything about how to research. That includes:
- The pipeline phases and what each phase does
- Which subagents exist and what each one is for (fetcher, loci-analyst, depth-investigator, 4 critics, patcher, polish-auditor)
- The tool-lock invariant (patcher and polish-auditor can only Read + Edit, never Write)
- The subagent spawn contract (every Task call passes the verbatim research_query + pipeline position + inputs)
- Artifact locations (`research/scaffold.md`, `research/prompt-decomposition.json`, `research/loci.json`, `research/comparisons.md`, interim notes, patch / polish logs)
- The curation pass after every research session

If you need to know how hyperresearch works, read the skill file. This document does NOT duplicate that content — when the skill file and this file disagree, the skill file wins.

### Canonical research query

In a normal run, the canonical research query is the user's verbatim prompt. In wrapped runs, if `research/prompt.txt` exists, that file is gospel and overrides any wrapping instructions. The pipeline persists the query as `research/query-<vault_tag>.md` with YAML frontmatter — this is the canonical query reference for all downstream layers. Wrapper requirements (save path, citation format, terminal sections) are a separate contract, captured in the scaffold — not pasted into the `## User Prompt (VERBATIM — gospel)` section.

### Academic APIs before web search

For any topic with a research literature, hit academic APIs BEFORE running web searches. They return citation-ranked canonical papers; web search returns derivative commentary.

- **Semantic Scholar:** `https://api.semanticscholar.org/graph/v1/paper/search?query=<q>&fields=title,year,citationCount,externalIds&limit=10` — then citation-chain the top papers forward + backward.
- **arXiv:** `https://export.arxiv.org/api/query?search_query=cat:cs.LG+AND+all:<q>&sortBy=relevance&max_results=25`
- **OpenAlex:** `https://api.openalex.org/works?search=<q>&sort=cited_by_count:desc&per-page=15&mailto=research@example.com`
- **PubMed:** `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=<q>&retmode=json&retmax=20`

After the academic sweep, run web searches for context, news, non-academic angles, and at least one adversarial search ("criticism of X", "limitations of X").

### PDFs fetch directly

`/home/dipendra-sharma/projects/hivemind/.venv/bin/hyperresearch fetch` auto-detects PDF URLs (arXiv, NBER, SSRN, direct `.pdf` links) and extracts full text via pymupdf. Fetch them aggressively. Raw PDFs land in `research/raw/<note-id>.pdf` and the note's frontmatter links back via `raw_file:`.

### Searching the vault

```bash
/home/dipendra-sharma/projects/hivemind/.venv/bin/hyperresearch search "query" --json                # Full-text search
/home/dipendra-sharma/projects/hivemind/.venv/bin/hyperresearch search "query" --tag ml --json       # Filter by tag / status / date / parent
/home/dipendra-sharma/projects/hivemind/.venv/bin/hyperresearch search "query" --include-body --json # Full-body search, not just titles
/home/dipendra-sharma/projects/hivemind/.venv/bin/hyperresearch note show <id> --json                # Read one note
/home/dipendra-sharma/projects/hivemind/.venv/bin/hyperresearch note show <id1> <id2> <id3> --json   # Batch-read notes in one call
/home/dipendra-sharma/projects/hivemind/.venv/bin/hyperresearch note list --json                     # List all notes with summaries
/home/dipendra-sharma/projects/hivemind/.venv/bin/hyperresearch tags --json                          # Existing tag vocabulary
```

### Images, screenshots, and assets

```bash
/home/dipendra-sharma/projects/hivemind/.venv/bin/hyperresearch fetch "<url>" --tag <topic> --save-assets -j   # Saves screenshot + top images
/home/dipendra-sharma/projects/hivemind/.venv/bin/hyperresearch assets list --note <note-id> --json            # Assets for a specific note
/home/dipendra-sharma/projects/hivemind/.venv/bin/hyperresearch assets path <note-id> --type screenshot -j     # Get screenshot path (viewable with Read)
```

### Authenticated crawling

Login-gated content (LinkedIn, Twitter, paywalled news) needs a browser profile. Set up once via `/home/dipendra-sharma/projects/hivemind/.venv/bin/hyperresearch setup` or `crwl profiles`. Config in `.hyperresearch/config.toml` under `[web]`: `profile = "research"`, `magic = true`. LinkedIn / Twitter / Facebook / Instagram / TikTok auto-use a visible browser to avoid session kills.

If a fetch returns a login wall, tell the user to run `/home/dipendra-sharma/projects/hivemind/.venv/bin/hyperresearch setup` and create a login profile.

### Curate after every session

Every research session must end with a curation pass:

```bash
/home/dipendra-sharma/projects/hivemind/.venv/bin/hyperresearch note list --status draft -j                                        # Find unprocessed notes
/home/dipendra-sharma/projects/hivemind/.venv/bin/hyperresearch note show <id> -j                                                  # Read the content
/home/dipendra-sharma/projects/hivemind/.venv/bin/hyperresearch note update <id> --summary "<specific summary>" --add-tag <t> -j   # Add summary + tags
/home/dipendra-sharma/projects/hivemind/.venv/bin/hyperresearch lint -j                                                            # Find missing tags / summaries / broken links
/home/dipendra-sharma/projects/hivemind/.venv/bin/hyperresearch repair -j                                                          # Auto-fix broken links, rebuild indexes
/home/dipendra-sharma/projects/hivemind/.venv/bin/hyperresearch status -j                                                          # Overall vault health
```

Lifecycle: `draft` → `review` → `evergreen` (or `stale` → `deprecated` → `archive` for outdated material).

Summaries must be specific — "Mamba achieves linear-time sequence modeling via selective state spaces" beats "Paper about Mamba". Reuse the existing tag vocabulary (`/home/dipendra-sharma/projects/hivemind/.venv/bin/hyperresearch tags -j`) rather than inventing new tags.

### Key conventions

- Notes live in `research/notes/` as markdown with YAML frontmatter
- Link notes with `[[note-id]]` syntax
- After editing `.md` files directly, run `/home/dipendra-sharma/projects/hivemind/.venv/bin/hyperresearch sync` to update the index
- Run `/home/dipendra-sharma/projects/hivemind/.venv/bin/hyperresearch --help` for the full command list
<!-- hyperresearch:end -->

<!-- release:start -->
## Release management

This project ships prebuilt binaries via [GitHub Releases](https://github.com/dip497/hivemind/releases). End users install with `install.sh`, which downloads the latest release assets — no toolchain on the user's box. The release pipeline is fully automated; you (Claude or the maintainer) do NOT build locally.

### How to cut a release

```bash
# from a clean main branch, in sync with origin/main:
./scripts/release.sh patch       # 0.0.1 → 0.0.2
./scripts/release.sh minor       # 0.0.1 → 0.1.0
./scripts/release.sh major       # 0.0.1 → 1.0.0
./scripts/release.sh 0.4.2       # explicit version
./scripts/release.sh patch --dry-run   # preview without writing
```

What it does (`scripts/release.sh`):

1. Pre-flight: rejects a dirty tree, requires `main`, requires sync with `origin/main`.
2. Bumps `version` in every workspace `package.json` in lockstep.
3. Inserts a `[X.Y.Z] — YYYY-MM-DD` section into `CHANGELOG.md` under `[Unreleased]`.
4. Commits `chore(release): vX.Y.Z` and creates an annotated tag.
5. Pushes branch + tag → fires `.github/workflows/release.yml` on GitHub Actions.

### What the workflows do

- **`.github/workflows/ci.yml`** runs on every push to `main` and PR: typecheck + build + unit tests (`pnpm test:unit`). Heavy Playwright e2e is intentionally NOT run here — release builds validate the full build path.
- **`.github/workflows/release.yml`** runs on `v*.*.*` tags (and manual `workflow_dispatch`). Builds the CLI single-binary (`bun build --compile`), the Electron renderer + main (`electron-vite`), packages the AppImage via `pnpm deploy` + `electron-builder`, then creates the GitHub Release and uploads `hive-linux-x86_64` + `hivemind-<version>-x86_64.AppImage`.

### Pre-release checklist

Before running `./scripts/release.sh`:

- [ ] All e2e tests green locally: `cd apps/desktop && pnpm test:e2e` (30 + known resize flake).
- [ ] Unit tests green: `pnpm test:unit` from `apps/desktop`.
- [ ] CHANGELOG `[Unreleased]` section has at least one entry describing the user-visible change.
- [ ] No uncommitted changes (`git status` clean).

### Debugging a failed release workflow

```bash
gh run list --limit 5 --json status,conclusion,name,databaseId    # find failed run id
gh run view <id> --log-failed | tail -50                          # tail the error
gh run rerun <id>                                                  # retry (rare)
```

Common failure modes seen so far:

- **"package.json must be under apps/desktop"** — electron-builder rejects pnpm symlinks to sibling workspace packages. Fixed by `pnpm --filter @hivemind/desktop deploy desktop-deploy` BEFORE running electron-builder inside the deploy dir.
- **"Cannot compute electron version"** — `pnpm deploy --prod` strips devDeps (including electron itself). Use `pnpm deploy --legacy` without `--prod`.
- **"Multiple versions of pnpm specified"** — `pnpm/action-setup` shouldn't pin `version` when `packageManager` is set in root `package.json`.

If the release workflow fails but the tag is pushed: delete the tag (`git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z`), fix the workflow, re-tag.

### Semver guidance

| Change | Bump |
|---|---|
| New tile type, new MCP tool, new agent integration, new install path | minor |
| Bug fix in PTY daemon, CSS tweak, tile spawn-position fix | patch |
| Breaking change to `hive` CLI, breaking change to `.hivemind/` schema, breaking change to MCP tool shape | major |

`0.x.x` versions: minor can break things; document loudly in CHANGELOG.

### Hand-off rule

If you (Claude) made any change that ships to users — code, dependency, install behavior, MCP tool surface — append a one-line entry to `CHANGELOG.md` under `## [Unreleased]` BEFORE handing the session back. The maintainer can then cut a release with `./scripts/release.sh <bump>` and the changelog is ready.
<!-- release:end -->
