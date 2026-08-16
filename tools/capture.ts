// Reading frames out of a headless machine, and arranging them into a sheet.
// Shared by the screenshot tools, which all wanted the same twenty lines.

import type { FantasyMachine } from "../src/core/machine.js";

export interface Image {
    pixels: Uint32Array;
    width: number;
    height: number;
}

/**
 * Takes the machine's last frame as an image with square pixels.
 *
 * A 512-pixel mode has pixels half as wide as they are tall, so its rows are
 * doubled here - stretching vertically rather than squeezing horizontally,
 * which would throw away the detail the mode exists for.
 */
export function readFrame(machine: FantasyMachine, pixelAspect = 1): Image {
    const frame = machine.getFrame();
    if (!frame) throw new Error("no frame rendered yet");

    const image = frame.source.imageData;
    if (!image) throw new Error("frame has no imageData - not running headless?");

    const repeat = Math.max(1, Math.round(1 / pixelAspect));
    const width = frame.width;
    const height = frame.height * repeat;
    const source = new Uint32Array(image.data.buffer);
    const pixels = new Uint32Array(width * height);

    for (let y = 0; y < frame.height; ++y) {
        const row = source.subarray(y * image.width, y * image.width + width);
        for (let n = 0; n < repeat; ++n) pixels.set(row, (y * repeat + n) * width);
    }
    return { pixels, width, height };
}

/** Lays images out in a grid with a hairline between them. */
export function tile(shots: readonly Image[], columns: number, gap = 2): Image {
    const { width: w, height: h } = shots[0];
    const rows = Math.ceil(shots.length / columns);
    const width = w * columns + gap * (columns - 1);
    const height = h * rows + gap * (rows - 1);

    const pixels = new Uint32Array(width * height);
    pixels.fill(0xff303030);

    shots.forEach((shot, i) => {
        const ox = (i % columns) * (w + gap);
        const oy = ((i / columns) | 0) * (h + gap);
        for (let y = 0; y < h; ++y) {
            pixels.set(shot.pixels.subarray(y * w, (y + 1) * w), (oy + y) * width + ox);
        }
    });
    return { pixels, width, height };
}
