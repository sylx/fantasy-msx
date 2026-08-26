// Runs the EDITOR headlessly, types into it, and writes what the screen looks
// like afterwards - which is the only way to see a keyboard work without one.
//
// The keystrokes go in through `runtime.keyboard`, the same object a browser
// host presses keys on. Nothing here is a test double: the repeat clock, the
// queue and the console's shadow buffer are all the ones the browser drives.
//
// What is missing under node is a rasteriser, so the editor falls back to the
// machine's own ROM font and the Japanese in its sample document comes out as
// question marks. That is not a defect of this tool - it is what a ROM font has
// to say about Japanese, and the reason the atlas the browser fills exists.

import { writeFileSync } from "node:fs";
import { boot } from "../src/index.js";
import { demo } from "../examples/editor/demo.js";
import { readFrame } from "./capture.js";
import { encodePNG } from "./png.js";

const runtime = boot();
runtime.run(demo);
runtime.step(1);

/** Types a string and lets a frame go by, so the console paints it. */
function type(text: string): void {
    runtime.keyboard.type(text);
    runtime.step(1);
}

/** Presses a named key - the ones that have no character of their own. */
function press(key: string, times = 1): void {
    for (let i = 0; i < times; ++i) {
        runtime.keyboard.press({ code: key, key });
        runtime.keyboard.release(key);
        runtime.step(1);
    }
}

// Down to the foot of the document, then a paragraph of its own onto the end.
press("PageDown", 2);
press("End");
type("\n\nTyped by tools/editor.ts, through the same keyboard a browser\n");
type("presses: keystrokes in, a queue, and a caret that keeps up.");

// Back up into the middle of the text, so the caret is somewhere visible and
// the line number under it is marked.
press("PageUp");
press("ArrowUp", 3);
press("Home");
press("ArrowRight", 12);

runtime.step(2);

const image = readFrame(runtime.bios.system.machine, runtime.screen.pixelAspect);
const out = process.argv[2] ?? "editor.png";
writeFileSync(out, encodePNG(image.pixels, image.width, image.height));

const term = runtime.console;
console.log(`${out}: ${image.width}x${image.height}, ${term.cols}x${term.rows} cells `
    + `(${term.cellWidth}x${term.cellHeight}), ${term.repainted} repainted on the last frame`);
