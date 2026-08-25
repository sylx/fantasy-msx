# hechima spike

Three questions that block deciding whether [hechima](https://github.com/msonrm/hechima)
— Mozc compiled to WebAssembly, with a UI-less conversion session layer over it —
can be the machine's Japanese input.

```bash
./fetch-vendor.sh                                   # 21.9MB, gitignored
node run.mjs                                        # in a browser, from a subpath
node run.mjs --gzip                                 # the same, pre-compressed dictionary
node node-probe.mjs                                 # the same stack, headless in node
```

`run.mjs` needs playwright (`npm i -D playwright && npx playwright install chromium`,
or `PLAYWRIGHT=/path/to/playwright node run.mjs`). `node-probe.mjs` needs nothing.
Neither is part of the console's build or its tests.

Measured against **hechima 0.22.1 / keymap-engine 2.5.0 / hechima-wasm 0.7.1
single-thread**, the set VENDOR.md calls verified together.

## 1. Does `feed()` need a DOM event?  — No

`hechima.d.ts` types it as `KeyTap`, commented "KeyboardEvent 互換の最小形（DOM 型に
依存しない）": `key`, and optionally `code` / `repeat` / `shiftKey` / `ctrlKey` /
`altKey` / `metaKey`. Confirmed by feeding plain object literals — `にほんご` came
out of seven of them.

That is the same shape [`runtime/keyboard.ts`](../../src/runtime/keyboard.ts)
already hands out, give or take the modifier names (`shift` against `shiftKey`).
An adapter of six lines, and nothing about the machine's own keyboard changes.

## 2. Does it survive a subpath?  — Yes, if the paths are worker-relative

The console deploys to `sylx.github.io/fantasy-msx/` with vite's `base: "./"`.
EMBEDDING.md's example uses absolute `/vendor/...` paths, which would 404 there.

They do not have to be absolute. The worker is loaded relative to the page, and
`init({ wasmJs, dataUrl })` resolves **relative to the worker script**, so
`"../hechima-wasm/hechima-wasm.js"` works from any prefix and knows nothing
about it. `run.mjs` serves the page from `/fantasy-msx/spike/` to prove it.

`crossOriginIsolated` was `false` throughout: no COOP/COEP, as documented.

## 3. What does a cold load cost?  — 15.4MB, and 0.35s once it is there

| | bytes |
|---|---|
| `mozc.data` | 18,890,236 → **13,188,234** pre-compressed (-30%) |
| `hechima-wasm.wasm` | 2,702,858 → 975,610 if the host compresses it (-64%) |
| `hechima-wasm.js` | 79,636 |
| `keymap-engine.js` | 148,723 |
| `hechima.js` | 34,125 |
| `hechima-worker.js` | 15,368 |
| **total fetched** | **20.9MB raw, 15.4MB with `mozc.data.gz`** |

Against the console itself at 199KB (54.8KB gzipped), the dictionary alone is
**240 times the whole machine**. That is the number the decision actually turns
on, and no amount of arranging changes it.

`.wasm` is 2.7MB and EMBEDDING.md does not mention it, so budget 15.4MB rather
than the 12.8MB the dictionary note implies — unless the host also compresses
the wasm, which GitHub Pages may or may not do for `application/wasm`.

Once the bytes are in hand it is fast: **init 0.35s**, a warm conversion
**3.5ms**. A 60Hz frame is 16.7ms, so conversion is not a pacing problem — it is
a download problem.

Everything is fetched once and cached, and none of it needs to be fetched at all
until an app asks for Japanese. `onProgress(loaded, total)` is there to be drawn.

## 4. Does it run headless?  — Yes, with a 40-line shim

This was expected to be the blocker. `new Worker()` under node's `worker_threads`
dies immediately (`self is not defined`): the engine ships as a Web Worker script.

But the seams are structural. `HechimaWorkerLike` is `postMessage` plus
`addEventListener`, and a real `Worker` is only one way to have them.
[`node-probe.mjs`](node-probe.mjs) fakes a worker global scope — `self`,
`importScripts`, and a `fetch` that reads files off the disk — and the whole
stack comes up:

```
ready in 109ms
yomi:  にほんごにゅうりょく
  focus "日本語"  candidates ["日本語","ニホンゴ","にほんご"]
  other "入力"    candidates ["入力","入リョク","にゅうりょく",...]
committed: "日本語入力"
```

Learning is off, because it wants OPFS and node has not got one. Conversion,
segmentation and candidates all work without it.

So the IME is testable the way everything else here is testable, and the
screenshot tools could render Japanese.

## What `show(segments)` gives the console to draw

```json
[
  { "text": "日本語", "kind": "focus",
    "candidates": ["日本語", "ニホンゴ", "にほんご"], "candidateIndex": 0 },
  { "text": "入力", "kind": "other",
    "candidates": ["入力", "入リョク", "にゅうりょく", "ニュウリョク"] }
]
```

`kind` is `yomi` / `focus` / `other`, which is exactly the three ways a preedit
has to be drawn differently. Nothing here is a DOM node, a style or a position:
where the candidate window goes and what it looks like is the machine's business,
which is the whole reason to prefer this over the browser's own IME.

## What is still unknown

- **Over a real network.** 15.4MB was measured off localhost. The transfer from
  GitHub Pages, and what it feels like on a phone, are not measured here.
- **The glyphs.** None of this draws a kanji. The VRAM atlas behind
  `GlyphSource` is still the prerequisite, and it is unaffected by any of the
  above.
- **The keymap.** This spike used the built-in romaji path, which VENDOR.md says
  is being folded away ("ページは必ず `keymap` を指定すること"). A real
  integration should load `keymaps/romaji.json` through KeymapEngine.
- **OPFS learning in a browser.** `features.persist` reported true but nothing
  here exercised it across reloads.
