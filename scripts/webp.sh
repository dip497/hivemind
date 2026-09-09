#!/usr/bin/env bash
# Convert a screen recording into a README-sized animated WebP.
#   scripts/webp.sh demo.mp4 screenshots/board.webp [width]
# ponytail: ffmpeg one-liner, no pipeline. Palette-gen dithering only matters for GIF; WebP is truecolor.
set -euo pipefail

src=${1:?usage: webp.sh <in.mp4> <out.webp> [width=900]}
out=${2:?usage: webp.sh <in.mp4> <out.webp> [width=900]}
w=${3:-900}

ffmpeg -y -i "$src" \
  -vf "fps=15,scale=${w}:-2:flags=lanczos" \
  -loop 0 -c:v libwebp -lossless 0 -q:v 62 -compression_level 6 -an \
  "$out"

printf '%s → %s (%s)\n' "$src" "$out" "$(du -h "$out" | cut -f1)"
[ "$(stat -c%s "$out")" -gt 10000000 ] && echo "WARNING: >10MB, GitHub will be slow. Lower -q:v or trim the clip." >&2
exit 0
