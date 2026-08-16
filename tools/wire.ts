// Runs the WIRE demo headlessly and tiles four moments, so the animation can be
// checked without a browser.

import { writeFileSync } from "node:fs";
import { boot } from "../src/index.js";
import { demo } from "../examples/wire/demo.js";
import { readFrame, tile } from "./capture.js";
import { encodePNG } from "./png.js";

const runtime = boot();
runtime.run(demo);

const shots = [];
for (const at of [10, 40, 80, 140]) {
    while (runtime.frame < at) runtime.step();
    // SCREEN 7 pixels are tall, so the rows get doubled on the way out.
    shots.push(readFrame(runtime.bios.system.machine, runtime.screen.pixelAspect));
}

const sheet = tile(shots, 1);

const out = process.argv[2] ?? "wire.png";
writeFileSync(out, encodePNG(sheet.pixels, sheet.width, sheet.height));
console.log(`${out}: ${shots[0].width}x${shots[0].height} frames at 10, 40, 80, 140  (bgm ${runtime.bgm.playing ? "playing" : "silent"})`);
