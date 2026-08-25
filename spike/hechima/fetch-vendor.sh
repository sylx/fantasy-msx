#!/usr/bin/env bash
# Fetches the pinned hechima vendor bundle into ./vendor/.
#
# The versions here are the set VENDOR.md calls verified together. hechima warns
# that mixing layers breaks silently, so this is a set or nothing - the same
# discipline scripts/vendor.sh applies to WebMSX.
#
#   hechima         v0.22.1
#   keymap-engine   v2.5.0
#   hechima-wasm    v0.7.1 + single-thread (2026-07-25)
#
# 21.9MB, of which 18.9MB is the Mozc dictionary. Not committed.

set -euo pipefail
cd "$(dirname "$0")"

REPO=https://raw.githubusercontent.com/msonrm/hechima/main/site/public/vendor

fetch() {
    mkdir -p "vendor/$(dirname "$1")"
    echo "  $1"
    curl -fsSL --max-time 300 "$REPO/$1" -o "vendor/$1"
}

echo "fetching hechima vendor bundle..."
fetch hechima/hechima.js
fetch hechima/hechima-worker.js
fetch hechima/hechima.d.ts
fetch keymap-engine/keymap-engine.js
fetch hechima-wasm/hechima-wasm.js
fetch hechima-wasm/hechima-wasm.wasm
fetch hechima-wasm/BUILD_INFO.txt
fetch hechima-wasm/mozc.data

# The worker tries <dataUrl>.gz first and falls back to the raw file. GitHub
# Pages will not compress .data on the fly, so the pre-compressed copy has to
# exist as a file of its own - this is the step a real build would take.
echo "compressing the dictionary..."
gzip -9 -c vendor/hechima-wasm/mozc.data > vendor/hechima-wasm/mozc.data.gz

du -sh vendor
ls -l vendor/hechima-wasm/mozc.data vendor/hechima-wasm/mozc.data.gz | awk '{printf "  %-24s %12d\n", $9, $5}'
