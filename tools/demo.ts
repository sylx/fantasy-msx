// Renders the same scene at four points in time, tiled into one image, so the
// blitter's pace can be seen rather than described.

import { writeFileSync } from "node:fs";
import { createBios } from "../src/bios/index.js";
import { encodePNG } from "./png.js";

const { screen, gfx, sprites, system } = createBios();

// Set the screen up instantly - nobody wants to watch the boot screen arrive.
screen.setBackdrop(1);
for (let i = 0; i < 8; ++i) screen.setColor(i + 8, 7 - i, i, 4);
gfx.now.clear(1);

sprites.setPatternFromBitmap(0, [
    "......####......", "....########....", "...##########...", "..############..",
    ".##############.", "################", "################", "################",
    "################", "################", ".##############.", "..############..",
    "...##########...", "....########....", "......####......", "................"
]);
const shade = [15, 15, 11, 11, 10, 10, 9, 9, 8, 8, 6, 6, 4, 4, 1, 1];
for (let i = 0; i < 6; ++i) sprites.set(i, { x: 24 + i * 38, y: 178, pattern: 0, color: shade });
sprites.setActiveCount(6);

// Everything from here is queued, and arrives at the machine's own speed.
gfx.clear(4);
gfx.fillRect(8, 8, 240, 20, 12);
gfx.text(14, 14, "THE MACHINE IS DRAWING THIS", 15);
gfx.fillCircle(70, 100, 44, 10);
gfx.circle(70, 100, 48, 15);
gfx.rect(140, 56, 100, 88, 15);
for (let i = 0; i <= 12; ++i) gfx.line(145, 61, 145 + i * 7, 139, 8 + (i & 7));
gfx.text(14, 158, "queued: fills, lines, glyphs", 11);

const SNAPSHOTS = [1, 2, 4, 10];
const shots: Array<{ pixels: Uint32Array; width: number; height: number; label: number }> = [];

for (let frame = 1; frame <= SNAPSHOTS[SNAPSHOTS.length - 1]; ++frame) {
    screen.frame();
    if (!SNAPSHOTS.includes(frame)) continue;

    const rendered = system.machine.getFrame()!;
    const image = rendered.source.imageData!;
    const all = new Uint32Array(image.data.buffer);
    const pixels = new Uint32Array(rendered.width * rendered.height);
    for (let y = 0; y < rendered.height; ++y) {
        pixels.set(all.subarray(y * image.width, y * image.width + rendered.width), y * rendered.width);
    }
    shots.push({ pixels, width: rendered.width, height: rendered.height, label: frame });
}

// Tile the snapshots 2x2 with a one pixel gap.
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

const out = process.argv[2] ?? "demo.png";
writeFileSync(out, encodePNG(sheet, w * 2 + gap, h * 2 + gap));
console.log(`${out}: frames ${SNAPSHOTS.join(", ")} after ${SNAPSHOTS.at(-1)} frames of drawing`);
