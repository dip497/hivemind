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
