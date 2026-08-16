#!/usr/bin/env bash
# Copies the minimal WebMSX core we depend on into src/core/vendor/.
# Files are copied VERBATIM (only an import header is prepended) so that
# upstream changes can be re-applied with a plain `git diff`.
set -euo pipefail

SRC="${1:-WebMSX/src/main}"
DST="src/core/vendor"
UPSTREAM_SHA="$(git -C "${SRC%/src/main}" rev-parse --short HEAD 2>/dev/null || echo unknown)"

FILES=(
  "util/Util.js"
  "msx/machine/DeviceMissing.js"
  "msx/video/ColorCache.js"
  "msx/video/VideoStandard.js"
  "msx/video/VideoSignal.js"
  "msx/video/VDPCommandProcessor.js"
  "msx/video/VDP.js"
  "msx/audio/AudioTables.js"
  "msx/audio/AudioSignal.js"
  "msx/audio/PSGAudio.js"
  "msx/audio/YM2413Tables.js"
  "msx/audio/YM2413Audio.js"
)

mkdir -p "$DST"
for f in "${FILES[@]}"; do
  base="$(basename "$f")"
  {
    echo "// VENDORED from WebMSX ($f @ $UPSTREAM_SHA) -- DO NOT EDIT."
    echo "// Regenerate with: npm run vendor"
    echo "import \"../env/globals.js\";"
    cat "$SRC/$f"
  } > "$DST/$base"
  echo "  vendored $base"
done
echo "Done. Upstream: WebMSX @ $UPSTREAM_SHA"
