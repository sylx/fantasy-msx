import type { Frame } from "../src/core/machine.js";

/**
 * Reads back the pixels of a frame rendered under the headless canvas shim.
 * Pixels are packed as the browser packs ImageData on a little-endian host:
 * 0xAABBGGRR.
 */
export function framePixels(frame: Frame): Uint32Array {
    const imageData = frame.source.imageData;
    if (!imageData) throw new Error("frame has no imageData - not running headless?");

    // The VDP allocates its buffer at the largest signal size it supports and
    // renders the current signal into the top-left corner, so crop to the part
    // the frame actually covers.
    const all = new Uint32Array(imageData.data.buffer, imageData.data.byteOffset);
    const out = new Uint32Array(frame.width * frame.height);
    for (let y = 0; y < frame.height; ++y) {
        out.set(all.subarray(y * imageData.width, y * imageData.width + frame.width), y * frame.width);
    }
    return out;
}

export function countColor(pixels: Uint32Array, color: number): number {
    let n = 0;
    for (let i = 0; i < pixels.length; ++i) if (pixels[i] === color) ++n;
    return n;
}

/** Histogram of the distinct colors in a frame, most frequent first. */
export function colorHistogram(pixels: Uint32Array): Array<{ color: string; count: number }> {
    const counts = new Map<number, number>();
    for (let i = 0; i < pixels.length; ++i) counts.set(pixels[i], (counts.get(pixels[i]) ?? 0) + 1);
    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([color, count]) => ({ color: "0x" + (color >>> 0).toString(16).padStart(8, "0"), count }));
}
