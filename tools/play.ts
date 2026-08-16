// Runs the example headlessly with a scripted controller and tiles four
// moments into one image. Proof that the loop, the input and the queue work
// without a browser in the way - and that the chip's pace is visible.

import { writeFileSync } from "node:fs";
import { BUTTON, boot } from "../src/index.js";
import { game } from "../examples/game.js";
import { encodePNG } from "./png.js";

const runtime = boot();
runtime.run(game);              // the headless host does not start a clock

function tap(button: number, frames = 1): void {
    runtime.input.setButton(button as never, true);
    runtime.step(frames);
    runtime.input.setButton(button as never, false);
}

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

// Fly about and fire a couple of blooms.
runtime.step(4);
tap(BUTTON.LEFT, 14);
tap(BUTTON.A);
runtime.step(10);
tap(BUTTON.RIGHT, 26);
tap(BUTTON.A);
while (runtime.gfx.busy) runtime.step();
const shots = [capture()];

// Then a full-screen wipe, caught while the chip is still working through it.
tap(BUTTON.B);
for (const frames of [4, 10]) {
    runtime.step(frames);
    shots.push(capture());
}
while (runtime.gfx.busy) runtime.step();
runtime.step(1);
shots.push(capture());

const { width: w, height: h } = shots[0];
const gap = 2;
const sheet = new Uint32Array((w * 2 + gap) * (h * 2 + gap));
sheet.fill(0xff303030);
shots.forEach((shot, i) => {
    const ox = (i % 2) * (w + gap);
    const oy = ((i / 2) | 0) * (h + gap);
    for (let y = 0; y < h; ++y) {
        sheet.set(shot.pixels.subarray(y * w, (y + 1) * w), (oy + y) * (w * 2 + gap) + ox);
    }
});

const out = process.argv[2] ?? "play.png";
writeFileSync(out, encodePNG(sheet, w * 2 + gap, h * 2 + gap));
console.log(`${out}: frame ${runtime.frame}, t=${runtime.time.toFixed(2)}s`);
