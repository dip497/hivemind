#!/usr/bin/env bash
# Builds the workspace the demo films, from nothing: three well-known open-source projects at
# pinned commits, each a hivemind workspace with its issues, plus a branch and a worktree for the
# agents that work apart. Run it again to start over: it deletes what it made first.
#
#   apps/desktop/scripts/demo-media/demo-workspace.sh [DIR]     # default /tmp/hivemind-demo
#
# It lives outside any home folder, so no path an agent prints names the person who runs it.
#
# excalidraw (MIT), ripgrep (Unlicense or MIT), fastapi (MIT).
set -euo pipefail

DIR=${1:-${DEMO_HOME:-/tmp/hivemind-demo}}
HERE=$(cd "$(dirname "$0")" && pwd)
APP=$(cd "$HERE/../../../.." && pwd)
# Its own hivemind config, so nothing lands in the config of whoever runs it.
hive() { XDG_CONFIG_HOME="$DIR/.config" bun "$APP/apps/cli/src/index.ts" "$@"; }

REPOS=(
  "excalidraw https://github.com/excalidraw/excalidraw.git 4c37956ba5f04ec342a9d9d5891a38f22c5b7b4e EXC"
  "ripgrep https://github.com/BurntSushi/ripgrep.git 3fce3b5bb0236da2df6d99672afb8a719642eca7 RG"
  "fastapi https://github.com/fastapi/fastapi.git b23d78f2ce4e7b3ea48a59f51ca249690d9fd02c FAS"
)

rm -rf "$DIR"
mkdir -p "$DIR/worktrees"
export GIT_AUTHOR_NAME=hivemind GIT_AUTHOR_EMAIL=demo@hivemind.dev GIT_COMMITTER_NAME=hivemind GIT_COMMITTER_EMAIL=demo@hivemind.dev
export GIT_AUTHOR_DATE=2026-10-18T09:00:00Z GIT_COMMITTER_DATE=2026-10-18T09:00:00Z

for line in "${REPOS[@]}"; do
  read -r name url sha prefix <<< "$line"
  repo="$DIR/$name"
  git init -q -b main "$repo"
  git -C "$repo" remote add origin "$url"
  git -C "$repo" fetch -q --depth 40 origin "$sha"
  git -C "$repo" reset -q --hard FETCH_HEAD
  (cd "$repo" && hive init --prefix "$prefix" --json > /dev/null)
  git -C "$repo" add -A && git -C "$repo" commit -q -m "Track this work with hivemind"
done

issue() { (cd "$DIR/$1" && hive new "$2" --state "$3" --description "$(printf '%b' "$4")" ${5:+--ac "$5"} --json > /dev/null); }

issue excalidraw "Arrows lose their binding when the target is rotated" in_progress \
  "Rotate a rectangle with a bound arrow: the arrow keeps its old end point.\n\nSee \`packages/element/src/binding.ts\`." \
  "Reproduce with a test||Fix the end point after rotation||No change for unbound arrows"
issue excalidraw "Export at 3x for retina screenshots" todo "PNG export offers 1x and 2x only."
issue excalidraw "Faster hit testing on scenes with 5,000 elements" backlog "Profile \`hitElementItself\` on the large-scene fixture."
issue ripgrep "Document how --glob and --iglob combine" in_progress \
  "The guide says nothing about the order globs apply in.\n\nSee \`GUIDE.md\`." "Write the section||Add an example per flag"
issue ripgrep "Count matches per file type" todo "\`--type-list\` names the types; \`--count\` does not group by them."
issue fastapi "Docstrings for the helpers in fastapi/utils.py" in_progress \
  "Three helpers have none: \`generate_unique_id\`, \`get_value_or_default\`, \`is_body_allowed_for_status_code\`." \
  "generate_unique_id||get_value_or_default||is_body_allowed_for_status_code"
issue fastapi "Show the release checklist on the board" todo "A widget beside the agent doing the release, ticked as it goes."
issue fastapi "Typed responses in the advanced tutorial" backlog "Several examples return bare dicts."

# The agents that work apart, each on its own branch in its own worktree.
git -C "$DIR/excalidraw" worktree add -q -b fix/arrow-binding "$DIR/worktrees/excalidraw-arrow-binding"
git -C "$DIR/ripgrep" worktree add -q -b docs/glob-order "$DIR/worktrees/ripgrep-glob-order"

# Work already under way on those branches: real edits, not yet committed.
wt="$DIR/worktrees/ripgrep-glob-order"
python3 - "$wt/GUIDE.md" <<'EOF'
import sys
p = sys.argv[1]
s = open(p).read()
mark = "\n### Manual filtering: file types\n"
note = ("\n### Manual filtering: globs and their order\n\n"
        "When several `--glob` flags are given, the last one that matches a path wins. "
        "`--iglob` is the same flag without case. Put the broad rule first and the exception after it:\n\n"
        "```\n$ rg clap --glob '*.rs' --glob '!*_test.rs'\n```\n")
assert mark in s, "GUIDE.md moved its file types section"
open(p, "w").write(s.replace(mark, note + mark, 1))
EOF
wt="$DIR/worktrees/excalidraw-arrow-binding"
file=$(git -C "$wt" ls-files 'packages/element/src/binding.ts' | head -1)
[ -n "$file" ] && printf '\n// Rotation moves the bound end: recompute it from the rotated target (EXC-1).\n' >> "$wt/$file"

echo "demo workspace ready in $DIR"
for line in "${REPOS[@]}"; do read -r name _ <<< "$line"; printf '  %-11s %s\n' "$name" "$(git -C "$DIR/$name" log -1 --format='%h %s')"; done
git -C "$DIR/excalidraw" worktree list | sed 's/^/  /'
git -C "$DIR/ripgrep" worktree list | sed 's/^/  /'
