#!/usr/bin/env bash
# scripts/release.sh — cut a new hivemind release.
#
# What it does (in order):
#   1. Verifies a clean working tree and that you're on main.
#   2. Computes the next version (semver bump or explicit).
#   3. Updates `version` in apps/*/package.json + packages/*/package.json
#      + root package.json. Keeps them in lockstep.
#   4. Adds a CHANGELOG.md skeleton entry for the new version (if missing).
#   5. Commits "chore(release): vX.Y.Z" and creates an annotated tag.
#   6. Pushes branch + tag → fires .github/workflows/release.yml on GitHub
#      Actions, which builds the CLI + AppImage and publishes the Release.
#
# Usage:
#   ./scripts/release.sh patch          # 0.0.1 → 0.0.2
#   ./scripts/release.sh minor          # 0.0.1 → 0.1.0
#   ./scripts/release.sh major          # 0.0.1 → 1.0.0
#   ./scripts/release.sh 0.4.2          # explicit
#   ./scripts/release.sh --dry-run patch  # show the plan, don't write anything
#
# Pre-flight is intentionally strict — releases are visible to users.
#
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
say()  { printf '%b\n' "${BLUE}▸${NC} $*"; }
ok()   { printf '%b\n' "${GREEN}✓${NC} $*"; }
warn() { printf '%b\n' "${YELLOW}!${NC} $*"; }
die()  { printf '%b\n' "${RED}✗${NC} $*" >&2; exit 1; }

DRY=0
ARG=""
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    patch|minor|major|*.*.*) ARG="$a" ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) die "unknown arg: $a" ;;
  esac
done
[ -n "$ARG" ] || die "usage: ./scripts/release.sh <patch|minor|major|X.Y.Z> [--dry-run]"

# Resolve repo root + cd to it.
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "not in a git repo"
cd "$ROOT"

# 1. Clean tree + on main + remote up-to-date.
say "pre-flight checks"
git diff --quiet || die "working tree dirty — commit or stash first"
git diff --cached --quiet || die "staged but uncommitted changes — commit first"
BRANCH=$(git rev-parse --abbrev-ref HEAD)
[ "$BRANCH" = "main" ] || die "not on main (on '$BRANCH'). Switch: git switch main"
say "fetching origin/main"
git fetch origin main --tags --quiet
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
[ "$LOCAL" = "$REMOTE" ] || die "local main is not up-to-date with origin/main. Run: git pull --ff-only"
ok "tree clean, on main, in sync with origin"

# 2. Compute next version.
CUR=$(node -p "require('./package.json').version")
say "current version: $CUR"
case "$ARG" in
  patch|minor|major)
    NEXT=$(node -e "
      const [maj, min, pat] = process.argv[1].split('.').map(Number);
      const bump = process.argv[2];
      if (bump === 'patch') console.log(\`\${maj}.\${min}.\${pat + 1}\`);
      else if (bump === 'minor') console.log(\`\${maj}.\${min + 1}.0\`);
      else console.log(\`\${maj + 1}.0.0\`);
    " "$CUR" "$ARG")
    ;;
  *) NEXT="$ARG" ;;
esac
[[ "$NEXT" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "invalid next version: $NEXT"
TAG="v$NEXT"
say "next version:    $NEXT  (tag: $TAG)"

# Tag must not already exist.
if git rev-parse "$TAG" >/dev/null 2>&1; then
  die "tag $TAG already exists locally"
fi
if git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
  die "tag $TAG already exists on origin"
fi

# 3. Update all package.json files in lockstep.
files=()
while IFS= read -r f; do files+=("$f"); done < <(find . -maxdepth 4 -type f -name package.json \
  ! -path './node_modules/*' ! -path './**/node_modules/*' \
  ! -path './apps/desktop/dist-electron/*' ! -path './*/dist/*' )

say "updating ${#files[@]} package.json files"
for f in "${files[@]}"; do
  # Only update files that ALREADY have a "version" field — packages/tsconfig has no version.
  if grep -q '"version"' "$f"; then
    if [ "$DRY" = "1" ]; then
      printf "  (dry) %s\n" "$f"
    else
      # In-place sed: match the FIRST "version": "..." (top-level field).
      sed -i.bak -E "0,/(\"version\"[[:space:]]*:[[:space:]]*\")[^\"]+(\")/s//\1$NEXT\2/" "$f"
      rm -f "$f.bak"
      printf "  %s\n" "$f"
    fi
  fi
done

# 4. CHANGELOG entry (template if Unreleased section is empty).
if [ -f CHANGELOG.md ] && [ "$DRY" = "0" ]; then
  TODAY=$(date +%Y-%m-%d)
  if grep -q "^## \[Unreleased\]" CHANGELOG.md; then
    if ! grep -q "^## \[$NEXT\]" CHANGELOG.md; then
      # Insert a new versioned section right after [Unreleased].
      tmp=$(mktemp)
      awk -v ver="$NEXT" -v date="$TODAY" '
        /^## \[Unreleased\]/ { print; print ""; print "## [" ver "] — " date; next }
        { print }
      ' CHANGELOG.md > "$tmp" && mv "$tmp" CHANGELOG.md
      # Update the comparison link footer.
      sed -i.bak -E "s|^\[Unreleased\]: .*$|[Unreleased]: https://github.com/dip497/hivemind/compare/v$NEXT...HEAD\n[$NEXT]: https://github.com/dip497/hivemind/releases/tag/v$NEXT|" CHANGELOG.md
      rm -f CHANGELOG.md.bak
      say "CHANGELOG.md: added [$NEXT] section. EDIT IT before pushing."
    fi
  fi
fi

if [ "$DRY" = "1" ]; then
  ok "dry-run complete — no files changed, no tag created"
  exit 0
fi

# Sanity: re-check we DID write something.
git diff --quiet && die "nothing changed (was the version already $NEXT?)"

# 5. Commit + tag.
say "committing + tagging"
git add -A
git commit -m "chore(release): $TAG"
git tag -a "$TAG" -m "$TAG"

# 6. Push (branch + tag in one go).
say "pushing main + $TAG → origin"
git push origin main
git push origin "$TAG"

ok "released $TAG"
say "release workflow: https://github.com/dip497/hivemind/actions"
say "the release will appear at: https://github.com/dip497/hivemind/releases/tag/$TAG"
