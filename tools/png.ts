// Minimal PNG codec, used to turn rendered frames into files we can look at
// and to read artwork back in outside a browser. Node-only: it needs zlib.

import { deflateSync, inflateSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ImageDecoder, RgbaImage } from "../src/index.js";

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; ++n) {
        let c = n;
        for (let k = 0; k < 8; ++k) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

function crc32(buf: Uint8Array): number {
    let c = -1;
    for (let i = 0; i < buf.length; ++i) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const body = Buffer.concat([head.subarray(4), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([head, data, tail]);
}

/** `pixels` is 0xAABBGGRR per pixel, as ImageData packs them on a little-endian host. */
export function encodePNG(pixels: Uint32Array, width: number, height: number): Buffer {
    const raw = Buffer.alloc(height * (width * 4 + 1));
    let p = 0;
    for (let y = 0; y < height; ++y) {
        raw[p++] = 0;                               // filter: none
        for (let x = 0; x < width; ++x) {
            const c = pixels[y * width + x];
            raw[p++] = c & 0xff;                    // R
            raw[p++] = (c >>> 8) & 0xff;            // G
            raw[p++] = (c >>> 16) & 0xff;           // B
            raw[p++] = 0xff;                        // A: frames are always opaque once composited
        }
    }

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;        // bit depth
    ihdr[9] = 6;        // color type: RGBA

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", ihdr),
        chunk("IDAT", deflateSync(raw)),
        chunk("IEND", new Uint8Array(0))
    ]);
}

// --- Decoding -------------------------------------------------------------
//
// The browser decodes images for us; Node does not. This is the other half,
// enough of the PNG spec to read what an art tool writes: any colour type, any
// bit depth, no interlacing.

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Channels per pixel, by PNG colour type. Types 1, 5 and 7 do not exist. */
const CHANNELS = [1, 0, 3, 1, 2, 0, 4];

/** Decodes a PNG into RGBA, the way a canvas would hand it over. */
export function decodePNG(bytes: Uint8Array): RgbaImage {
    for (let i = 0; i < SIGNATURE.length; ++i) {
        if (bytes[i] !== SIGNATURE[i]) throw new Error("not a PNG");
    }

    let width = 0, height = 0, depth = 0, colorType = 0;
    let palette: Uint8Array | null = null;
    let alpha: Uint8Array | null = null;
    const parts: Uint8Array[] = [];

    for (let p = 8; p + 8 <= bytes.length;) {
        const length = readU32(bytes, p);
        const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
        const body = bytes.subarray(p + 8, p + 8 + length);
        p += length + 12;                                    // length, type, data, CRC

        if (type === "IHDR") {
            width = readU32(body, 0);
            height = readU32(body, 4);
            depth = body[8];
            colorType = body[9];
            if (body[12] !== 0) throw new Error("interlaced PNGs are not supported");
        } else if (type === "PLTE") palette = body;
        else if (type === "tRNS") alpha = body;
        else if (type === "IDAT") parts.push(body);
        else if (type === "IEND") break;
    }

    const channels = CHANNELS[colorType];
    if (!channels) throw new Error(`unsupported PNG colour type ${colorType}`);

    const bitsPerPixel = channels * depth;
    const stride = Math.ceil((width * bitsPerPixel) / 8);
    const raw = unfilter(inflateSync(concat(parts)), width, height, stride, Math.max(1, bitsPerPixel >> 3));

    return { width, height, data: toRgba(raw, width, height, stride, depth, colorType, channels, palette, alpha) };
}

/**
 * A decoder for Node, taking a file path, a `file:` URL or an http one. Hand
 * it to `bios.image.decoder` and `image.load()` works outside a browser.
 */
export function nodeDecoder(): ImageDecoder {
    return async (url: string): Promise<RgbaImage> => {
        if (/^https?:/.test(url)) {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`could not fetch ${url}: ${response.status}`);
            return decodePNG(new Uint8Array(await response.arrayBuffer()));
        }
        return decodePNG(await readFile(url.startsWith("file:") ? fileURLToPath(url) : url));
    };
}

/**
 * Reverses the per-scanline filters. Each row names its own, and every one of
 * them predicts a byte from the one to its left and the one above.
 */
function unfilter(data: Uint8Array, width: number, height: number, stride: number, bpp: number): Uint8Array {
    const out = new Uint8Array(height * stride);

    for (let y = 0; y < height; ++y) {
        const filter = data[y * (stride + 1)];
        const from = y * (stride + 1) + 1;
        const to = y * stride;
        const above = to - stride;

        for (let x = 0; x < stride; ++x) {
            const left = x >= bpp ? out[to + x - bpp] : 0;
            const up = y > 0 ? out[above + x] : 0;
            const corner = y > 0 && x >= bpp ? out[above + x - bpp] : 0;
            const value = data[from + x];

            switch (filter) {
                case 0: out[to + x] = value; break;
                case 1: out[to + x] = value + left; break;
                case 2: out[to + x] = value + up; break;
                case 3: out[to + x] = value + ((left + up) >> 1); break;
                case 4: out[to + x] = value + paeth(left, up, corner); break;
                default: throw new Error(`unknown PNG filter ${filter} on line ${y}`);
            }
        }
    }
    return out;
}

/** The predictor that picks whichever neighbour the gradient points at. */
function paeth(a: number, b: number, c: number): number {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function toRgba(
    raw: Uint8Array, width: number, height: number, stride: number, depth: number,
    colorType: number, channels: number, palette: Uint8Array | null, alpha: Uint8Array | null
): Uint8ClampedArray {
    const out = new Uint8ClampedArray(width * height * 4);
    const max = (1 << depth) - 1;
    const sample = sampler(raw, stride, depth);

    for (let y = 0; y < height; ++y) {
        for (let x = 0; x < width; ++x) {
            const base = x * channels;
            const q = (y * width + x) * 4;

            if (colorType === 3) {                          // indexed
                const index = sample(y, base);
                const entry = (palette ?? new Uint8Array(3)).subarray(index * 3, index * 3 + 3);
                out[q] = entry[0]; out[q + 1] = entry[1]; out[q + 2] = entry[2];
                out[q + 3] = alpha && index < alpha.length ? alpha[index] : 255;
            } else if (colorType === 0 || colorType === 4) { // grey, with or without alpha
                const grey = (sample(y, base) * 255) / max;
                out[q] = out[q + 1] = out[q + 2] = grey;
                out[q + 3] = colorType === 4 ? (sample(y, base + 1) * 255) / max : 255;
            } else {                                        // truecolour
                out[q] = (sample(y, base) * 255) / max;
                out[q + 1] = (sample(y, base + 1) * 255) / max;
                out[q + 2] = (sample(y, base + 2) * 255) / max;
                out[q + 3] = colorType === 6 ? (sample(y, base + 3) * 255) / max : 255;
            }
        }
    }
    return out;
}

/** Reads sample `n` of row `y`, whatever width the samples are packed at. */
function sampler(raw: Uint8Array, stride: number, depth: number): (y: number, n: number) => number {
    if (depth === 8) return (y, n) => raw[y * stride + n];
    if (depth === 16) return (y, n) => raw[y * stride + n * 2] * 256 + raw[y * stride + n * 2 + 1];

    const perByte = 8 / depth;
    const mask = (1 << depth) - 1;
    return (y, n) => (raw[y * stride + ((n / perByte) | 0)] >> ((perByte - 1 - (n % perByte)) * depth)) & mask;
}

function concat(parts: Uint8Array[]): Uint8Array {
    let length = 0;
    for (const part of parts) length += part.length;
    const out = new Uint8Array(length);
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; }
    return out;
}

function readU32(bytes: Uint8Array, at: number): number {
    return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}
