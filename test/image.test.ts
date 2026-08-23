import { describe, expect, it } from "vitest";
import { LEVELS_2BIT, LEVELS_3BIT, color256Rgb, rgbToColor256 } from "../src/api/index.js";
import { createBios, type RgbaImage } from "../src/bios/index.js";
import { decodePNG, encodePNG } from "../tools/png.js";

/** An RGBA source built from a function of the coordinates. */
function source(width: number, height: number, at: (x: number, y: number) => [number, number, number, number?]): RgbaImage {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; ++y) {
        for (let x = 0; x < width; ++x) {
            const [r, g, b, a] = at(x, y);
            data.set([r, g, b, a ?? 255], (y * width + x) * 4);
        }
    }
    return { width, height, data };
}

const solid = (r: number, g: number, b: number, width = 8, height = 8) =>
    source(width, height, () => [r, g, b]);

describe("pixel packing across the bitmap modes", () => {
    it("keeps GRAPHIC4 in nibbles, high one first", () => {
        const { gfx, system } = createBios();
        gfx.now.clear(0);
        gfx.now.pixel(0, 0, 0x0a);
        gfx.now.pixel(1, 0, 0x03);
        expect(system.vdp.vram[0]).toBe(0xa3);
    });

    it("packs four pixels to a byte in GRAPHIC5", () => {
        const { gfx, screen, system } = createBios();
        screen.setMode("G5");
        gfx.now.clear(0);
        gfx.now.pixel(0, 0, 3);
        gfx.now.pixel(2, 0, 1);
        expect(system.vdp.vram[0]).toBe(0b11_00_01_00);
        expect(gfx.getPixel(0, 0)).toBe(3);
        expect(gfx.getPixel(2, 0)).toBe(1);
        expect(gfx.getPixel(1, 0)).toBe(0);
    });

    it("gives a whole byte to a pixel in GRAPHIC7", () => {
        const { gfx, screen, system } = createBios();
        screen.setMode("G7");
        gfx.now.clear(0);
        gfx.now.pixel(0, 0, 0xb6);
        gfx.now.pixel(1, 0, 0x1f);
        expect(system.vdp.vram[0]).toBe(0xb6);
        expect(system.vdp.vram[1]).toBe(0x1f);
        expect(gfx.getPixel(0, 0)).toBe(0xb6);
    });

    it("fills a run that starts and ends mid-byte without disturbing its neighbours", () => {
        const { gfx, screen, system } = createBios();
        screen.setMode("G5");
        gfx.now.clear(0);
        gfx.now.hline(1, 0, 6, 3);          // pixels 1..6, so bytes 0 and 1 are half-covered
        expect(system.vdp.vram[0]).toBe(0b00_11_11_11);
        expect(system.vdp.vram[1]).toBe(0b11_11_11_00);
        expect(system.vdp.vram[2]).toBe(0);
    });

    it("clears a page with the mode's own colour width", () => {
        const { gfx, screen, system } = createBios();
        screen.setMode("G7");
        gfx.now.clear(0xc9);
        expect(system.vdp.vram[0]).toBe(0xc9);
        expect(system.vdp.vram[255]).toBe(0xc9);
        screen.setMode("G5");
        gfx.now.clear(2);
        expect(system.vdp.vram[0]).toBe(0b10101010);
    });
});

describe("reducing to a palette", () => {
    it("picks the nearest entry of the palette on screen", () => {
        const { image, screen } = createBios();
        screen.resetPalette();
        // Entry 8 is bright red, entry 4 dark blue: nothing else is close.
        const red = image.reduce(solid(255, 0, 0), { dither: "none" });
        const blue = image.reduce(solid(30, 30, 200), { dither: "none" });
        expect([...new Set(red.pixels)]).toEqual([8]);
        expect([...new Set(blue.pixels)]).toEqual([4]);
    });

    it("follows the palette rather than the picture", () => {
        const { image, screen } = createBios();
        screen.resetPalette();
        const before = image.reduce(solid(255, 0, 0), { dither: "none" }).pixels[0];

        // Repaint the entry it chose as green; the same source must land elsewhere.
        screen.setColor(before, 0, 7, 0);
        const after = image.reduce(solid(255, 0, 0), { dither: "none" }).pixels[0];
        expect(after).not.toBe(before);
    });

    it("stays out of the entries it was told to leave alone", () => {
        const { image, screen } = createBios();
        screen.resetPalette();
        const reduced = image.reduce(solid(255, 255, 255), { dither: "none", exclude: [15] });
        expect(reduced.pixels).not.toContain(15);
    });

    it("sends transparent source pixels to the index reserved for them", () => {
        const { image } = createBios();
        const half = source(4, 1, (x) => [255, 255, 255, x < 2 ? 0 : 255]);
        const reduced = image.reduce(half, { dither: "none", transparentIndex: 0 });
        expect([...reduced.pixels]).toEqual([0, 0, 15, 15]);
    });

    it("uses only 4 colours in GRAPHIC5", () => {
        const { image, screen } = createBios();
        screen.setMode("G5");
        const ramp = source(64, 8, (x) => [x * 4, x * 4, x * 4]);
        const reduced = image.reduce(ramp);
        for (const pixel of reduced.pixels) expect(pixel).toBeLessThan(4);
    });
});

describe("reducing to GRAPHIC7", () => {
    it("packs the byte as three bits of green, three of red and two of blue", () => {
        // 0xb6 = green 5, red 5, blue 2.
        expect(color256Rgb(0xb6)).toEqual([LEVELS_3BIT[5], LEVELS_3BIT[5], LEVELS_2BIT[2]]);
        expect(rgbToColor256(LEVELS_3BIT[5], LEVELS_3BIT[5], LEVELS_2BIT[2])).toBe(0xb6);
    });

    it("ignores the palette, which GRAPHIC7 does not have", () => {
        const { image, screen } = createBios();
        screen.setMode("G7");
        const reduced = image.reduce(solid(255, 0, 0), { dither: "none" });
        expect([...new Set(reduced.pixels)]).toEqual([rgbToColor256(255, 0, 0)]);
    });

    it("reaches colours a 16-entry palette could not", () => {
        const { image, screen } = createBios();
        screen.setMode("G7");
        const ramp = source(64, 4, (x) => [x * 4, 0, 0]);
        const reduced = image.reduce(ramp, { dither: "none" });
        expect(new Set(reduced.pixels).size).toBe(8);       // 3 bits of red, and nothing else
    });
});

describe("dithering", () => {
    it("mixes two palette entries where none of them fits", () => {
        const { image, screen } = createBios();
        screen.resetPalette();
        // This grey sits between entry 14 and white; nearest picks one, dither uses both.
        const grey = solid(218, 218, 218, 32, 32);
        expect(new Set(image.reduce(grey, { dither: "none" }).pixels).size).toBe(1);
        expect(new Set(image.reduce(grey, { dither: "ordered" }).pixels).size).toBeGreaterThan(1);
        expect(new Set(image.reduce(grey, { dither: "floyd-steinberg" }).pixels).size).toBeGreaterThan(1);
    });

    it("repeats on a 4x4 grid when ordered, so it holds still", () => {
        const { image, screen } = createBios();
        screen.resetPalette();
        const grey = solid(218, 218, 218, 16, 16);
        const { pixels } = image.reduce(grey, { dither: "ordered" });
        for (let y = 0; y < 16; ++y) {
            for (let x = 0; x < 16; ++x) {
                expect(pixels[y * 16 + x]).toBe(pixels[(y & 3) * 16 + (x & 3)]);
            }
        }
    });

    it("does nothing at zero strength", () => {
        const { image, screen } = createBios();
        screen.resetPalette();
        const grey = solid(218, 218, 218, 16, 16);
        expect(new Set(image.reduce(grey, { dither: "ordered", ditherAmount: 0 }).pixels).size).toBe(1);
    });
});

describe("fitting", () => {
    it("keeps art that already fits at the size it was drawn", () => {
        const { image } = createBios();
        const reduced = image.reduce(solid(255, 0, 0, 16, 24));
        expect([reduced.width, reduced.height]).toEqual([16, 24]);
    });

    it("shrinks a picture too big for the screen", () => {
        const { image } = createBios();
        const reduced = image.reduce(solid(255, 0, 0, 512, 512));
        expect([reduced.width, reduced.height]).toEqual([212, 212]);
    });

    it("takes the second side from the first", () => {
        const { image } = createBios();
        const reduced = image.reduce(solid(255, 0, 0, 100, 50), { width: 40 });
        expect([reduced.width, reduced.height]).toEqual([40, 20]);
    });

    it("fits a picture whole with contain and fills the box with cover", () => {
        const { image } = createBios();
        const wide = solid(255, 0, 0, 200, 50);
        expect(image.reduce(wide, { width: 100, height: 100, fit: "contain" }).height).toBe(25);
        const covered = image.reduce(wide, { width: 100, height: 100, fit: "cover" });
        expect([covered.width, covered.height]).toEqual([100, 100]);
    });

    it("doubles the pixels of a 512-wide mode so the shape survives", () => {
        const { image, screen } = createBios();
        screen.setMode("G6");                               // 512x212, pixels half as wide
        const square = solid(255, 0, 0, 100, 100);
        const reduced = image.reduce(square, { width: 400, height: 200 });
        // 200 tall, and twice that in half-width pixels to come out square.
        expect([reduced.width, reduced.height]).toEqual([400, 200]);

        const flat = image.reduce(solid(255, 0, 0, 200, 100), { width: 400, height: 200 });
        expect([flat.width, flat.height]).toEqual([400, 100]);
    });

    it("averages the pixels it drops rather than picking one", () => {
        const { image, screen } = createBios();
        screen.setMode("G7");
        // A checkerboard of black and white must reduce to something grey.
        const checker = source(64, 64, (x, y) => ((x + y) & 1 ? [255, 255, 255] : [0, 0, 0]));
        const reduced = image.reduce(checker, { width: 8, height: 8, dither: "none" });
        const [r] = color256Rgb(reduced.pixels[0]);
        expect(r).toBeGreaterThan(80);
        expect(r).toBeLessThan(190);
    });
});

describe("generating a palette", () => {
    it("finds the colours the picture is actually made of", () => {
        const { image, screen } = createBios();
        const stripes = source(64, 8, (x) =>
            x < 21 ? [255, 0, 0] : x < 42 ? [0, 255, 0] : [0, 0, 255]);

        const palette = image.palette(stripes, { colors: 4 });
        screen.setPalette(palette);
        expect(palette.slice(0, 4)).toEqual(
            expect.arrayContaining([[7, 0, 0], [0, 7, 0], [0, 0, 7]])
        );
    });

    it("returns all sixteen entries, leaving the reserved ones as they were", () => {
        const { image, screen } = createBios();
        screen.resetPalette();
        screen.setColor(0, 1, 2, 3);
        const palette = image.palette(solid(255, 0, 0), { reserve: 1 });
        expect(palette).toHaveLength(16);
        expect(palette[0]).toEqual([1, 2, 3]);
        expect(palette[1]).toEqual([7, 0, 0]);
    });

    it("makes a picture land closer once its own palette is loaded", () => {
        const { image, screen } = createBios();
        screen.resetPalette();
        // Sixteen shades of one hue: the boot palette has nothing like it.
        const teal = source(64, 8, (x) => [0, 90 + (x & 15) * 10, 100 + (x & 15) * 9]);
        const before = new Set(image.reduce(teal, { dither: "none" }).pixels).size;

        screen.setPalette(image.palette(teal));
        const after = new Set(image.reduce(teal, { dither: "none" }).pixels).size;
        expect(after).toBeGreaterThan(before);
    });
});

describe("putting a picture in VRAM", () => {
    it("writes straight through with drawNow", () => {
        const { image, gfx, screen } = createBios();
        screen.setMode("G7");
        gfx.now.clear(0);
        const picture = image.reduce(solid(255, 0, 0, 4, 4), { dither: "none" });
        image.drawNow(picture, 2, 2);
        expect(gfx.getPixel(2, 2)).toBe(rgbToColor256(255, 0, 0));
        expect(gfx.getPixel(6, 2)).toBe(0);
    });

    it("arrives over several frames when it goes through the blitter", () => {
        const { image, gfx, screen, system } = createBios();
        gfx.now.clear(0);
        const picture = image.reduce(solid(255, 0, 0, 200, 200), { dither: "none" });
        image.draw(picture, 0, 0);
        expect(gfx.busy).toBe(true);

        system.machine.frame();
        expect(gfx.work).toBeGreaterThan(0);                // not done in one frame
        for (let i = 0; i < 60 && gfx.busy; ++i) system.machine.frame();
        expect(gfx.busy).toBe(false);
        expect(gfx.getPixel(199, 199)).toBe(8);
    });

    it("centres what show() loads", async () => {
        const { image, gfx, screen } = createBios();
        screen.setMode("G4");
        gfx.now.clear(0);
        image.decoder = async () => solid(255, 0, 0, 64, 64);

        const shown = await image.show("anywhere.png");
        expect([shown.width, shown.height]).toEqual([212, 212]);
        expect(gfx.getPixel(128, 106)).toBe(8);             // middle of the screen
        expect(gfx.getPixel(2, 106)).toBe(0);               // margin either side
    });

    it("refuses a mode with no framebuffer to write into", () => {
        const { image, screen } = createBios();
        screen.setMode("G2");
        expect(() => image.reduce(solid(255, 0, 0))).toThrow(/no framebuffer/);
    });
});

describe("the PNG decoder the tools use", () => {
    it("reads back what the encoder wrote", () => {
        const pixels = new Uint32Array(4 * 3);
        for (let i = 0; i < pixels.length; ++i) pixels[i] = 0xff000000 | (i * 0x00112233);

        const decoded = decodePNG(encodePNG(pixels, 4, 3));
        expect([decoded.width, decoded.height]).toEqual([4, 3]);
        for (let i = 0; i < pixels.length; ++i) {
            expect(decoded.data[i * 4]).toBe(pixels[i] & 0xff);
            expect(decoded.data[i * 4 + 1]).toBe((pixels[i] >>> 8) & 0xff);
            expect(decoded.data[i * 4 + 2]).toBe((pixels[i] >>> 16) & 0xff);
            expect(decoded.data[i * 4 + 3]).toBe(255);
        }
    });

    it("feeds a loaded file through the whole path", async () => {
        const { image, gfx, screen } = createBios();
        screen.setMode("G7");
        gfx.now.clear(0);

        const png = encodePNG(Uint32Array.from({ length: 16 }, () => 0xff0000ff), 4, 4);   // red
        image.decoder = async () => decodePNG(png);

        const picture = await image.load("red.png", { dither: "none" });
        image.drawNow(picture, 0, 0);
        expect(gfx.getPixel(0, 0)).toBe(rgbToColor256(255, 0, 0));
    });
});
