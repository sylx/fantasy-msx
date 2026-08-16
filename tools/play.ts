// Plays the example headlessly with a scripted controller and tiles four
// moments into one image - proof that the loop, input, sprites, blitter and
// driver all work together without a browser in the way.

import { writeFileSync } from "node:fs";
import { BUTTON, boot } from "../src/index.js";
import { game } from "../examples/game.js";
import { encodePNG } from "./png.js";

const runtime = boot();
runtime.run(game);

function hold(button: number, frames: number): void {
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

const shots: Array<ReturnType<typeof capture>> = [];

// The title screen, waiting to be started.
runtime.step(20);
shots.push(capture());

// Start, then fly about spraying. Held down, the spray is gated by the queue.
hold(BUTTON.B, 2);
runtime.step(4);
hold(BUTTON.A, 20);
hold(BUTTON.LEFT, 10);
hold(BUTTON.A, 20);
shots.push(capture());

runtime.input.setButton(BUTTON.RIGHT as never, true);
hold(BUTTON.A, 40);
runtime.input.setButton(BUTTON.RIGHT as never, false);
runtime.input.setButton(BUTTON.DOWN as never, true);
hold(BUTTON.A, 40);
runtime.input.setButton(BUTTON.DOWN as never, false);
shots.push(capture());

runtime.step(120);
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
