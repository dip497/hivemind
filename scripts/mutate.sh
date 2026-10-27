#!/usr/bin/env bash
# Prove a test can fail: break the code it guards, run it, put the code back.
#
#   scripts/mutate.sh <file> <exact text> <replacement> -- <test command…>
#   scripts/mutate.sh packages/view-host/src/link.ts 'a ?? b' 'b' -- bun test packages/view-host
#   scripts/mutate.sh apps/desktop/src/renderer/src/App.tsx 'void f()' '{}' -- \
#     apps/desktop/scripts/e2e.sh settings-extensions -g "first open"
#
# The text must occur exactly once. "caught" (exit 0) when the command fails, as it should;
# "SURVIVED" (exit 1) when it passes: the test does not guard that code. 2 when it could not run.
#
# The file is copied back however the run ends, unless something else wrote it during the run: then
# it is left as written and the code from before the mutation is kept beside it, so an edit made
# meanwhile is never lost, and the run exits 2: what the test ran against is not known. A run that built the mutation into apps/desktop/out (an e2e spec) is built
# again from the restored code, so nothing run after it tests broken code.
set -euo pipefail

[ $# -ge 5 ] && [ "$4" = "--" ] || { sed -n '2,15p' "$0"; exit 2; }
file="$1" old="$2" new="$3"; shift 4
[ -f "$file" ] || { echo "no file $file" >&2; exit 2; }
desktop="$(cd "$(dirname "$0")/.." && pwd)/apps/desktop"

backup="$(mktemp)" since="$(mktemp)" mutated="" overwritten=""
cp "$file" "$backup"
restore() {
  if [ -n "$mutated" ] && ! cmp -s "$file" "$mutated"; then
    overwritten=1
    cp "$backup" "$file.before-mutation"
    echo "NOT restored: something else wrote $file during the run, so this run proves nothing; the code from before the mutation is in $file.before-mutation" >&2
  else
    cp "$backup" "$file"
    echo "restored $file"
  fi
  if [ -d "$desktop/out" ] && [ -n "$(find "$desktop/out" -newer "$since" -print -quit)" ]; then
    echo "building $desktop/out again from the restored code"
    (cd "$desktop" && pnpm exec electron-vite build && node scripts/build-views.mjs) > /dev/null 2>&1 \
      || echo "that build failed: build apps/desktop before anything uses out/" >&2
  fi
  rm -f "$backup" "$since" "$mutated"
  [ -z "$overwritten" ] || exit 2
}
trap restore EXIT

OLD="$old" NEW="$new" python3 - "$file" <<'EOF' || exit 2
import os, sys
path, old, new = sys.argv[1], os.environ["OLD"], os.environ["NEW"]
text = open(path).read()
n = text.count(old)
if n != 1:
    sys.exit(f"the text occurs {n} times in {path}, not once")
open(path, "w").write(text.replace(old, new))
EOF
mutated="$(mktemp)"
cp "$file" "$mutated"

echo "mutated $file: $old → $new"
if "$@"; then echo "SURVIVED: the test passed with the code broken"; exit 1; fi
echo "caught: the test failed with the code broken"
