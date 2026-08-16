// Runs the example headlessly with a scripted controller and writes what the
// screen looked like. Proof that the loop, the input and the queue work
// without a browser in the way.

import { writeFileSync } from "node:fs";
import { BUTTON, boot } from "../src/index.js";
import { game } from "../examples/game.js";
import { encodePNG } from "./png.js";

const runtime = boot();
runtime.run(game);              // the headless host does not start a clock

/** Holds a button for `frames`, then steps on with it released. */
function hold(button: number, frames: number): void {
    runtime.input.setButton(button as never, true);
    runtime.step(frames);
    runtime.input.setButton(button as never, false);
}

runtime.step(4);
hold(BUTTON.LEFT, 12);
hold(BUTTON.A, 2);
runtime.step(8);
hold(BUTTON.UP, 10);
hold(BUTTON.A, 2);
runtime.step(6);
hold(BUTTON.RIGHT, 20);
hold(BUTTON.A, 2);
runtime.step(Number(process.argv[3] ?? 10));

const frame = runtime.bios.system.machine.getFrame()!;
const image = frame.source.imageData!;
const all = new Uint32Array(image.data.buffer);
const pixels = new Uint32Array(frame.width * frame.height);
for (let y = 0; y < frame.height; ++y) {
    pixels.set(all.subarray(y * image.width, y * image.width + frame.width), y * frame.width);
}

const out = process.argv[2] ?? "play.png";
writeFileSync(out, encodePNG(pixels, frame.width, frame.height));
console.log(`${out}: frame ${runtime.frame}, t=${runtime.time.toFixed(2)}s, queue ${runtime.gfx.pending}, work ${runtime.gfx.work}`);
