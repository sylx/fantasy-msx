// Renders a demo frame and writes it to a PNG.
//
// Compare this against the raw port pokes it replaced: the V9938 is doing all
// the same work, but nothing here manipulates a register by number.

import { writeFileSync } from "node:fs";
import { createSystem, MODES, OP } from "../src/api/index.js";
import { encodePNG } from "./png.js";

const { vdp, machine } = createSystem();

/** Runs frames until the command engine goes idle. */
function settle(): void {
    machine.frame();
    while (vdp.cmd.busy) machine.frame();
}

vdp.setMode("G4", 0);           // SCREEN 5: 256x212, 16 colours
vdp.setDisplayEnabled(true);
vdp.setBackdrop(1);
machine.frame();                // geometry takes effect at the next vsync

// A ramp of blues, so the shapes below read as depth rather than as colour.
for (let i = 1; i < 8; ++i) vdp.setPaletteEntry(i, 0, i >> 1, i);
vdp.setPaletteEntry(15, 7, 7, 7);

vdp.cmd.fill(0, 0, 256, 212, 1);
settle();

// Nested frames, each one step brighter.
for (let i = 0; i < 7; ++i) {
    vdp.cmd.fill(8 + i * 14, 8 + i * 12, 240 - i * 28, 196 - i * 24, i + 1);
    settle();
}

// A star drawn with the line engine, XORed so the crossings show.
const cx = 128;
const cy = 106;
for (let i = 0; i < 12; ++i) {
    const a = (i / 12) * Math.PI * 2;
    vdp.cmd.lineTo(cx, cy, Math.round(cx + Math.cos(a) * 100), Math.round(cy + Math.sin(a) * 80), 15, OP.XOR);
    settle();
}

const frame = machine.getFrame()!;
const image = frame.source.imageData!;
const all = new Uint32Array(image.data.buffer);
const pixels = new Uint32Array(frame.width * frame.height);
for (let y = 0; y < frame.height; ++y) {
    pixels.set(all.subarray(y * image.width, y * image.width + frame.width), y * frame.width);
}

const out = process.argv[2] ?? "screenshot.png";
writeFileSync(out, encodePNG(pixels, frame.width, frame.height));
console.log(`${out}: ${frame.width}x${frame.height} (${MODES.G4.name}), ${machine.frames} frames, ${machine.cycles} cycles`);
