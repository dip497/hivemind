#!/usr/bin/env bash
# Prove a test can fail: break the code it guards, run it, put the code back.
#
#   scripts/mutate.sh <file> <exact text> <replacement> -- <test command…>
#   scripts/mutate.sh packages/view-host/src/link.ts 'a ?? b' 'b' -- bun test packages/view-host
#   scripts/mutate.sh apps/desktop/src/renderer/src/App.tsx 'void f()' '{}' -- \
#     apps/desktop/scripts/e2e.sh settings-extensions -g "first open"
#
# The text must occur exactly once. The file is copied back however the run ends. "caught" (exit 0)
# when the command fails, as it should; "SURVIVED" (exit 1) when it passes: the test does not guard
# that code. 2 when it could not run. e2e.sh builds the mutation into out/: build again before the
# next --no-build run.
set -euo pipefail

[ $# -ge 5 ] && [ "$4" = "--" ] || { sed -n '2,12p' "$0"; exit 2; }
file="$1" old="$2" new="$3"; shift 4
[ -f "$file" ] || { echo "no file $file" >&2; exit 2; }

backup="$(mktemp)"
cp "$file" "$backup"
trap 'cp "$backup" "$file"; rm -f "$backup"; echo "restored $file"' EXIT

OLD="$old" NEW="$new" python3 - "$file" <<'EOF' || exit 2
import os, sys
path, old, new = sys.argv[1], os.environ["OLD"], os.environ["NEW"]
text = open(path).read()
n = text.count(old)
if n != 1:
    sys.exit(f"the text occurs {n} times in {path}, not once")
open(path, "w").write(text.replace(old, new))
EOF

echo "mutated $file: $old → $new"
if "$@"; then echo "SURVIVED: the test passed with the code broken"; exit 1; fi
echo "caught: the test failed with the code broken"
