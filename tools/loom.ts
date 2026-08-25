// Runs the LOOM demo headlessly and writes what it composed, so the desk and
// the roll can be looked at - and the mouse worked - without a browser.
//
// The runtime's pointer is written to directly here. In a browser the host
// fills it in from the page's own pointer events; nothing downstream of it can
// tell the difference, which is the point of it being state rather than events.

import { writeFileSync } from "node:fs";
import { MOUSE, boot } from "../src/index.js";
import { demo } from "../examples/loom/demo.js";
import { readFrame, tile } from "./capture.js";
import { encodePNG } from "./png.js";

const runtime = boot();
runtime.run(demo);

const shots = [];

/** A click, which takes a frame to go down and a frame to come back up. */
function click(x: number, y: number): void {
    runtime.pointer.setPosition(x, y, true);
    runtime.pointer.setButton(MOUSE.LEFT, true);
    runtime.step(1);
    runtime.pointer.setButton(MOUSE.LEFT, false);
    runtime.step(1);
}

// The opening phrase, a bar or so in.
runtime.step(60);
shots.push(readFrame(runtime.bios.system.machine));

// The desk: the lead's voice changed, the pad muted, the arp pushed up.
click(90, 145);                     // LEAD's voice cell, right arrow
click(10, 134);                     // PAD's lamp: mute
runtime.pointer.setPosition(200, 178, true);
runtime.pointer.setButton(MOUSE.LEFT, true);
runtime.step(2);
runtime.pointer.setButton(MOUSE.LEFT, false);
runtime.step(30);
shots.push(readFrame(runtime.bios.system.machine));

// A new phrase, and a few bars of it.
click(238, 4);                      // NEW
runtime.step(200);
shots.push(readFrame(runtime.bios.system.machine));

// And one left to itself long enough to change on its own.
runtime.step(60 * 40);
shots.push(readFrame(runtime.bios.system.machine));

const sheet = tile(shots, 2);
const out = process.argv[2] ?? "loom.png";
writeFileSync(out, encodePNG(sheet.pixels, sheet.width, sheet.height));
console.log(`${out}: ${shots[0].width}x${shots[0].height} x${shots.length}`);
