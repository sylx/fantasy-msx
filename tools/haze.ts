// Runs the HAZE demo headlessly and tiles one moment from each of its patterns,
// so SCREEN 3 can be looked at without a browser.

import { writeFileSync } from "node:fs";
import { BUTTON, boot } from "../src/index.js";
import { demo } from "../examples/haze/demo.js";
import { readFrame, tile } from "./capture.js";
import { encodePNG } from "./png.js";

const runtime = boot();
runtime.run(demo);

const shots = [];

// One picture from each pattern, taken well after the dissolve into it has
// finished. X moves to the next rather than waiting out its four bars.
for (let i = 0; i < 5; ++i) {
    runtime.step(90);
    shots.push(readFrame(runtime.bios.system.machine, runtime.screen.pixelAspect));

    runtime.input.setButton(BUTTON.B, true);
    runtime.step(1);
    runtime.input.setButton(BUTTON.B, false);
    runtime.step(1);
}

const sheet = tile(shots, 2);

const out = process.argv[2] ?? "haze.png";
writeFileSync(out, encodePNG(sheet.pixels, sheet.width, sheet.height));
console.log(`${out}: ${shots[0].width}x${shots[0].height} x${shots.length}  (bgm ${runtime.bgm.playing ? "playing" : "silent"})`);
