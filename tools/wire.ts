// Runs the WIRE demo headlessly and tiles four moments, so the animation can be
// checked without a browser.

import { writeFileSync } from "node:fs";
import { boot } from "../src/index.js";
import { demo } from "../examples/wire/demo.js";
import { encodePNG } from "./png.js";

const runtime = boot();
runtime.run(demo);

function capture(): { pixels: Uint32Array; width: number; height: number } {
    const frame = runtime.bios.system.machine.getFrame()!;
    const image = frame.source.imageData!;
    const all = new Uint32Array(image.data.buffer);
    const pixels = new Uint32Array(frame.width * frame.height);
    for (let y = 0; y < frame.height; ++y) {
        pixels.set(all.subarray(y * image.width, y * image.width + frame.width), y * frame.width);
    }
    return { pixels, width: frame.width, height: frame.height };
}

const shots: Array<ReturnType<typeof capture>> = [];
for (const at of [10, 40, 80, 140]) {
    while (runtime.frame < at) runtime.step();
    shots.push(capture());
}

const { width: w, height: h } = shots[0];
const gap = 2;
const sheet = new Uint32Array(w * (h * shots.length + gap * (shots.length - 1)));
sheet.fill(0xff303030);
shots.forEach((shot, i) => {
    const oy = i * (h + gap);
    for (let y = 0; y < h; ++y) sheet.set(shot.pixels.subarray(y * w, (y + 1) * w), (oy + y) * w);
});

const out = process.argv[2] ?? "wire.png";
writeFileSync(out, encodePNG(sheet, w, h * shots.length + gap * (shots.length - 1)));
console.log(`${out}: ${w}x${h} frames at 10, 40, 80, 140  (bgm ${runtime.bgm.playing ? "playing" : "silent"})`);
