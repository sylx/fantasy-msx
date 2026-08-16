// Renders a page exercising the BIOS layer, so it can be checked by eye.

import { writeFileSync } from "node:fs";
import { createBios } from "../src/bios/index.js";
import { encodePNG } from "./png.js";

const { screen, gfx, sprites, system } = createBios();

screen.setBackdrop(1);
for (let i = 0; i < 8; ++i) screen.setColor(i + 8, 7 - i, i, 4);

gfx.clear(1);
gfx.fillRect(0, 0, 256, 24, 4);
gfx.text(6, 8, "FANTASY MSX  -  SCREEN 5  -  256x212x16", 15);

// The whole printable font, so every glyph gets looked at.
let row = 0;
for (let code = 32; code < 127; code += 32, ++row) {
    let line = "";
    for (let c = code; c < Math.min(code + 32, 127); ++c) line += String.fromCharCode(c);
    gfx.text(6, 32 + row * 10, line, 11);
}

// Primitives.
gfx.rect(6, 68, 80, 60, 15);
gfx.fillRect(12, 74, 30, 20, 8);
gfx.fillCircle(62, 98, 22, 10);
gfx.circle(62, 98, 26, 15);
for (let i = 0; i <= 10; ++i) gfx.line(12, 122, 12 + i * 7, 74, 9 + (i & 3));

// Clipping.
gfx.setClip(100, 68, 70, 60);
gfx.fillCircle(100, 98, 40, 12);
gfx.fillCircle(170, 98, 40, 14);
gfx.resetClip();
gfx.rect(100, 68, 70, 60, 15);
gfx.text(102, 132, "clipped", 15);

// Text with a background, and the shading palette.
for (let i = 0; i < 8; ++i) gfx.fillRect(184, 68 + i * 7, 60, 7, 8 + i);
gfx.text(186, 132, "palette", 1, 15);

// Hardware sprites: a 16x16 shape, shaded by giving each line its own colour.
sprites.setPatternFromBitmap(0, [
    "......####......",
    "....########....",
    "...##########...",
    "..############..",
    ".##############.",
    "################",
    "################",
    "################",
    "################",
    "################",
    ".##############.",
    "..############..",
    "...##########...",
    "....########....",
    "......####......",
    "................"
]);
const shade = [15, 15, 11, 11, 10, 10, 9, 9, 8, 8, 6, 6, 4, 4, 1, 1];
for (let i = 0; i < 8; ++i) {
    sprites.set(i, { x: 20 + i * 28, y: 150 + (i & 1) * 14, pattern: 0, color: shade });
}
sprites.setActiveCount(8);
gfx.text(6, 190, "8 hardware sprites, per-line colour", 15);

screen.frame();
screen.frame();

const frame = system.machine.getFrame()!;
const image = frame.source.imageData!;
const all = new Uint32Array(image.data.buffer);
const pixels = new Uint32Array(frame.width * frame.height);
for (let y = 0; y < frame.height; ++y) {
    pixels.set(all.subarray(y * image.width, y * image.width + frame.width), y * frame.width);
}

const out = process.argv[2] ?? "demo.png";
writeFileSync(out, encodePNG(pixels, frame.width, frame.height));
console.log(`${out}: ${frame.width}x${frame.height}, ${system.machine.frames} frames`);
