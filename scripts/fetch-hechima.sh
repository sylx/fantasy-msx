#!/usr/bin/env bash
# Fetches the hechima conversion engine into public/hechima/.
#
# hechima is Mozc built with Emscripten plus a session layer with no UI of its
# own (https://github.com/msonrm/hechima, MIT; the engine and dictionary are
# Mozc, BSD-3-Clause + NAIST License + Public Domain - powered by Mozc).
#
# It is not vendored into this repository the way WebMSX's core is: it is 21.9MB
# and it belongs to another project that is explicit about breaking across its
# own layer boundaries. So it is fetched as a pinned set - the combination
# hechima's VENDOR.md calls verified - and left out of git.
#
#   hechima         v0.22.1
#   keymap-engine   v2.5.0
#   hechima-wasm    v0.7.1 + single-thread (2026-07-25), which is what makes it
#                   run without COOP/COEP and therefore on GitHub Pages
#
# vite copies public/ into the build verbatim, so what lands here is what ships.

set -euo pipefail
cd "$(dirname "$0")/.."

REPO=https://raw.githubusercontent.com/msonrm/hechima/main/site/public/vendor
OUT=public/hechima

fetch() {
    mkdir -p "$OUT/$(dirname "$1")"
    printf '  %s\n' "$1"
    curl -fsSL --max-time 600 "$REPO/$1" -o "$OUT/$1"
}

echo "fetching hechima into $OUT ..."
fetch hechima/hechima.js
fetch hechima/hechima-worker.js
fetch hechima/hechima.d.ts
fetch keymap-engine/keymap-engine.js
fetch hechima-wasm/hechima-wasm.js
fetch hechima-wasm/hechima-wasm.wasm
fetch hechima-wasm/BUILD_INFO.txt
fetch hechima-wasm/mozc.data

# The worker asks for <dataUrl>.gz first and falls back to the plain file, so
# this is optional - but GitHub Pages will not compress .data on the fly, and
# 13.2MB against 18.9MB is the difference it makes.
if command -v gzip > /dev/null; then
    echo "  hechima-wasm/mozc.data.gz"
    gzip -9 -c "$OUT/hechima-wasm/mozc.data" > "$OUT/hechima-wasm/mozc.data.gz"
fi

# Attribution travels with the files, as the licence requires.
cat > "$OUT/NOTICE.md" <<'NOTE'
# powered by Mozc

Fetched by `scripts/fetch-hechima.sh`; not part of this repository.

- hechima - https://github.com/msonrm/hechima - MIT
- Mozc - Copyright (c) Google LLC - BSD-3-Clause
- fcitx5-mozc (build harness) - fcitx-contrib - BSD-3-Clause
- the dictionary - Mozc system dictionary - BSD-3-Clause + NAIST License + Public Domain

Full texts: https://github.com/msonrm/hechima/blob/main/THIRD_PARTY_NOTICES.md
NOTE

du -sh "$OUT"
