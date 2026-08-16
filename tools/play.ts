// Plays the example headlessly with a scripted controller and tiles four
// moments into one image - proof that the loop, input, sprites, blitter and
// driver all work together without a browser in the way.

import { writeFileSync } from "node:fs";
import { BUTTON, boot } from "../src/index.js";
import { game } from "../examples/ink/game.js";
import { readFrame, tile } from "./capture.js";
import { encodePNG } from "./png.js";

const runtime = boot();
runtime.run(game);

function hold(button: number, frames: number): void {
    runtime.input.setButton(button as never, true);
    runtime.step(frames);
    runtime.input.setButton(button as never, false);
}

const shots = [];
const capture = () => readFrame(runtime.bios.system.machine, runtime.screen.pixelAspect);

// The title screen, waiting to be started.
runtime.step(20);
shots.push(capture());

// Start, then fly about shooting. Held down, the trigger is gated by the queue.
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

const sheet = tile(shots, 2);

const out = process.argv[2] ?? "play.png";
writeFileSync(out, encodePNG(sheet.pixels, sheet.width, sheet.height));
console.log(`${out}: frame ${runtime.frame}, t=${runtime.time.toFixed(2)}s`);
