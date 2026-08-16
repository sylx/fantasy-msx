// Renders a demo frame and writes it to a PNG, so M0 can be checked by eye.
//
// Everything drawn here is drawn by the V9938's own command engine - there is
// no CPU, and no software rasteriser. The TypeScript side only pokes registers.

import { writeFileSync } from "node:fs";
import { FantasyMachine } from "../src/core/machine.js";
import { encodePNG } from "./png.js";

const m = new FantasyMachine();

function reg(r: number, value: number): void {
    m.vdp.output99(value);
    m.vdp.output99(0x80 | r);
}

/** V9938 command registers R32..R46, written in one indirect burst. */
function command(sx: number, sy: number, dx: number, dy: number, nx: number, ny: number, color: number, arg: number, cmd: number): void {
    reg(17, 32);                    // indirect register pointer at R32, auto-incrementing
    const bytes = [
        sx & 0xff, (sx >> 8) & 0x01,
        sy & 0xff, (sy >> 8) & 0x03,
        dx & 0xff, (dx >> 8) & 0x01,
        dy & 0xff, (dy >> 8) & 0x03,
        nx & 0xff, (nx >> 8) & 0x01,
        ny & 0xff, (ny >> 8) & 0x03,
        color, arg, cmd
    ];
    for (const b of bytes) m.vdp.output9b(b);
}

const LMMV = 0x80;      // fill a rectangle, logical (pixel) coordinates
const LINE = 0x70;      // draw a line
const IMP  = 0x00;      // logical operation: copy

// SCREEN 5: 256x212, 16 colors out of 512.
reg(0, 0x06);           // GRAPHIC4
reg(1, 0x40);           // display on
reg(2, 0x1f);           // page 0 at VRAM 0x00000
reg(7, 0x00);           // backdrop: palette 0

// Background wash.
command(0, 0, 0, 0, 256, 212, 4, 0, LMMV | IMP);
m.frame();

// A few nested boxes.
const boxes: Array<[number, number, number, number, number]> = [
    [16, 16, 224, 180, 12],
    [32, 32, 192, 148, 5],
    [48, 48, 160, 116, 10],
    [64, 64, 128, 84, 9]
];
for (const [x, y, w, h, c] of boxes) {
    command(0, 0, x, y, w, h, c, 0, LMMV | IMP);
    m.frame();
}

// Diagonals across the middle box. ARG bit 0 picks the major axis, bit 2 the
// X direction, bit 3 the Y direction.
command(0, 0, 64, 64, 127, 83, 15, 0x00, LINE | IMP);
m.frame();
command(0, 0, 191, 64, 127, 83, 15, 0x04, LINE | IMP);
m.frame();

// Let the raster settle so the final frame contains everything.
m.frame();

const frame = m.getFrame();
if (!frame) throw new Error("no frame rendered");

const imageData = frame.source.imageData!;
const all = new Uint32Array(imageData.data.buffer);
const pixels = new Uint32Array(frame.width * frame.height);
for (let y = 0; y < frame.height; ++y) {
    pixels.set(all.subarray(y * imageData.width, y * imageData.width + frame.width), y * frame.width);
}

const out = process.argv[2] ?? "screenshot.png";
writeFileSync(out, encodePNG(pixels, frame.width, frame.height));
console.log(`${out}: ${frame.width}x${frame.height}, ${m.frames} frames, ${m.cycles} cycles`);
