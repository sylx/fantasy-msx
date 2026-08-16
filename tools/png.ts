// Minimal PNG encoder, used to turn rendered frames into files we can look at.
// Node-only: it needs zlib.

import { deflateSync } from "node:zlib";

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
