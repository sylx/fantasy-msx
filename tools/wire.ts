// Runs the WIRE demo headlessly and tiles four moments, so the animation can be
// checked without a browser.

import { writeFileSync } from "node:fs";
import { BUTTON, boot } from "../src/index.js";
import { demo } from "../examples/wire/demo.js";
import { readFrame, tile } from "./capture.js";
import { encodePNG } from "./png.js";

const runtime = boot();
runtime.run(demo);

const shots = [];
const capture = () => readFrame(runtime.bios.system.machine, runtime.screen.pixelAspect);

// Two frames of the software path, which rebuilds the picture every frame.
for (const at of [30, 45]) {
    while (runtime.frame < at) runtime.step();
    shots.push(capture());
}

// X hands the same scene to the blitter, which needs about a dozen frames for it.
runtime.input.setButton(BUTTON.B, true);
runtime.step(1);
runtime.input.setButton(BUTTON.B, false);

// Two finished pictures from the blitter. It draws on the hidden page and
// swaps, same as software, so a half-drawn one is never on screen - there is
// just a lot longer between them.
for (let i = 0; i < 2; ++i) {
    while (!runtime.gfx.busy) runtime.step();
    while (runtime.gfx.busy) runtime.step();
    runtime.step(1);
    shots.push(capture());
}

const sheet = tile(shots, 1);

const out = process.argv[2] ?? "wire.png";
writeFileSync(out, encodePNG(sheet.pixels, sheet.width, sheet.height));
console.log(`${out}: ${shots[0].width}x${shots[0].height}, software then blitter  (bgm ${runtime.bgm.playing ? "playing" : "silent"})`);
