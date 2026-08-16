import { describe, expect, it } from "vitest";
import { MODES, R } from "../src/api/index.js";
import { createBios } from "../src/bios/index.js";
import { pixelAt } from "./helpers.js";

const WHITE = 0xffffffff;

describe("Raster pixel packing", () => {
    it("addresses both nibbles of a byte", () => {
        const { gfx, system } = createBios();
        gfx.now.clear(0);
        gfx.now.pixel(0, 0, 0x0a);      // high nibble
        gfx.now.pixel(1, 0, 0x03);      // low nibble
        expect(system.vdp.vram[0]).toBe(0xa3);
        expect(gfx.getPixel(0, 0)).toBe(0x0a);
        expect(gfx.getPixel(1, 0)).toBe(0x03);
    });

    it("fills a run that starts and ends mid-byte without touching its neighbours", () => {
        const { gfx, system } = createBios();
        gfx.now.clear(0);
        gfx.now.hline(1, 0, 4, 7);      // pixels 1..4, so bytes 0 and 2 are half-covered
        expect(system.vdp.vram[0]).toBe(0x07);
        expect(system.vdp.vram[1]).toBe(0x77);
        expect(system.vdp.vram[2]).toBe(0x70);
        expect(system.vdp.vram[3]).toBe(0x00);
    });

    it("clears only the page being drawn on", () => {
        const { gfx, screen, system } = createBios();
        gfx.now.clear(0);
        screen.setDrawPage(1);
        gfx.now.clear(0x0f);
        expect(system.vdp.vram[0x0000]).toBe(0x00);
        expect(system.vdp.vram[0x8000]).toBe(0xff);
    });
});

describe("Raster clipping", () => {
    it("drops everything outside the clip rectangle", () => {
        const { gfx } = createBios();
        gfx.now.clear(0);
        gfx.setClip(10, 10, 4, 4);
        gfx.now.fillRect(0, 0, 256, 212, 9);

        expect(gfx.getPixel(9, 10)).toBe(0);
        expect(gfx.getPixel(10, 10)).toBe(9);
        expect(gfx.getPixel(13, 13)).toBe(9);
        expect(gfx.getPixel(14, 13)).toBe(0);
    });

    it("clamps a clip rectangle to the screen", () => {
        const { gfx } = createBios();
        gfx.setClip(-20, -20, 400, 400);
        expect(gfx.clip).toEqual({ x: 0, y: 0, width: 256, height: 212 });
    });
});

describe("Raster shapes", () => {
    it("draws a rectangle outline one pixel thick", () => {
        const { gfx } = createBios();
        gfx.now.clear(0);
        gfx.now.rect(4, 4, 10, 6, 15);

        expect(gfx.getPixel(4, 4)).toBe(15);
        expect(gfx.getPixel(13, 9)).toBe(15);
        expect(gfx.getPixel(5, 5)).toBe(0);         // hollow
        expect(gfx.getPixel(14, 4)).toBe(0);        // width is exclusive at the far edge
    });

    it("draws a line that reaches both endpoints", () => {
        const { gfx } = createBios();
        gfx.now.clear(0);
        gfx.now.line(3, 5, 40, 30, 12);
        expect(gfx.getPixel(3, 5)).toBe(12);
        expect(gfx.getPixel(40, 30)).toBe(12);
    });

    it("fills a circle without gaps along its widest row", () => {
        const { gfx } = createBios();
        gfx.now.clear(0);
        gfx.now.fillCircle(40, 40, 10, 6);
        for (let x = 31; x <= 49; ++x) expect(gfx.getPixel(x, 40)).toBe(6);
        expect(gfx.getPixel(40, 30)).toBe(6);        // radius 10 above the centre
        expect(gfx.getPixel(40, 29)).toBe(0);
    });

    it("skips colour 0 when drawing an image, unless told not to", () => {
        const { gfx } = createBios();
        gfx.now.clear(3);
        gfx.now.drawImage(0, 0, 2, 2, [0, 5, 5, 0]);
        expect(gfx.getPixel(0, 0)).toBe(3);
        expect(gfx.getPixel(1, 0)).toBe(5);

        gfx.now.drawImage(0, 0, 2, 2, [0, 5, 5, 0], false);
        expect(gfx.getPixel(0, 0)).toBe(0);
    });
});

describe("Raster blit", () => {
    it("copies a byte-aligned block a whole row at a time", () => {
        const { gfx } = createBios();
        gfx.now.clear(0);
        gfx.now.fillRect(0, 0, 8, 4, 11);
        gfx.now.blit(0, 0, 100, 50, 8, 4);
        expect(gfx.getPixel(100, 50)).toBe(11);
        expect(gfx.getPixel(107, 53)).toBe(11);
        expect(gfx.getPixel(108, 53)).toBe(0);
    });

    it("copies across pages, which is how a background gets restored", () => {
        const { gfx, screen } = createBios();
        screen.setDrawPage(1);
        gfx.now.clear(0);
        gfx.now.fillRect(20, 20, 16, 16, 4);        // background lives on page 1

        screen.setDrawPage(0);
        gfx.now.clear(0);
        gfx.now.blit(20, 20, 20, 20, 16, 16, { fromPage: 1 });
        expect(gfx.getPixel(20, 20)).toBe(4);
        expect(gfx.getPixel(35, 35)).toBe(4);
    });

    it("leaves colour 0 alone when copying with transparency", () => {
        const { gfx } = createBios();
        gfx.now.clear(0);
        gfx.now.pixel(1, 0, 6);                     // source: one pixel set, one clear
        gfx.now.fillRect(50, 50, 2, 1, 2);          // destination: both pixels set
        gfx.now.blit(0, 0, 50, 50, 2, 1, { transparent: true });
        expect(gfx.getPixel(50, 50)).toBe(2);   // kept
        expect(gfx.getPixel(51, 50)).toBe(6);   // overwritten
    });
});

describe("Raster text", () => {
    it("renders glyphs to the pixels the font describes", () => {
        const { gfx } = createBios();
        gfx.now.clear(0);
        gfx.now.text(0, 0, "L", 15);
        // "L" is a full-height stem with a foot: column 0 set on every row,
        // the rest of the top row clear.
        for (let y = 0; y < 7; ++y) expect(gfx.getPixel(0, y)).toBe(15);
        expect(gfx.getPixel(1, 0)).toBe(0);
        for (let x = 0; x < 5; ++x) expect(gfx.getPixel(x, 6)).toBe(15);
    });

    it("advances lines on a newline and reports its own width", () => {
        const { gfx } = createBios();
        gfx.now.clear(0);
        gfx.now.text(0, 0, "A\nBC", 15);
        expect(gfx.getPixel(1, 0)).toBe(15);        // top of the A
        expect(gfx.getPixel(0, 8)).toBe(15);        // stem of the B, one line down
        expect(gfx.textWidth("A\nBC")).toBe(12);
    });

    it("fills the cell behind the text when given a background", () => {
        const { gfx } = createBios();
        gfx.now.clear(0);
        gfx.now.text(0, 0, " ", 15, 3);
        expect(gfx.getPixel(0, 0)).toBe(3);
        expect(gfx.getPixel(5, 7)).toBe(3);
    });
});

describe("Screen pages", () => {
    it("shows one page while drawing on the other", () => {
        const { gfx, screen, system } = createBios();
        screen.useDoubleBuffer();
        expect(screen.displayPage).toBe(0);
        expect(screen.drawPage).toBe(1);

        gfx.now.clear(15);                              // lands on page 1, not shown yet
        screen.frame();
        expect(pixelAt(system.machine.getFrame()!, MODES.G4, 0, 0)).not.toBe(WHITE);

        screen.flip();
        screen.frame();
        expect(pixelAt(system.machine.getFrame()!, MODES.G4, 0, 0)).toBe(WHITE);
        expect(screen.displayPage).toBe(1);
        expect(screen.drawPage).toBe(0);
    });

    it("keeps R2's unused bits set when it moves the page", () => {
        const { screen, system } = createBios();
        screen.setDisplayPage(1);
        // Page 1 is at 0x08000: A15 selects it, and every bit the mode ignores stays 1.
        expect(system.vdp.read(R.LAYOUT_TABLE)).toBe(0x3f);
        screen.setDisplayPage(0);
        expect(system.vdp.read(R.LAYOUT_TABLE)).toBe(0x1f);
    });
});

describe("Sprites", () => {
    it("stores a sprite one line above where it appears", () => {
        const { sprites, system, screen } = createBios();
        sprites.set(3, { x: 40, y: 100, pattern: 8, color: 6 });
        const attribute = screen.spriteTables.attributes + 3 * 4;
        expect(system.vdp.vram[attribute]).toBe(99);
        expect(system.vdp.vram[attribute + 1]).toBe(40);
        expect(system.vdp.vram[attribute + 2]).toBe(8);
        expect(system.vdp.vram[screen.spriteTables.colors + 3 * 16]).toBe(6);
    });

    it("rounds a 16x16 sprite's pattern down to a multiple of four", () => {
        const { sprites, system, screen } = createBios();
        sprites.setSize(16);
        sprites.set(0, { x: 0, y: 0, pattern: 7, color: 1 });
        expect(system.vdp.vram[screen.spriteTables.attributes + 2]).toBe(4);
    });

    it("splits a 16-wide pattern into the halves the chip expects", () => {
        const { sprites, system, screen } = createBios();
        sprites.setPattern(0, [0xff00, 0x00ff, ...new Array(14).fill(0)]);
        expect(system.vdp.vram[screen.spriteTables.patterns]).toBe(0xff);        // left half, row 0
        expect(system.vdp.vram[screen.spriteTables.patterns + 16]).toBe(0x00);   // right half, row 0
        expect(system.vdp.vram[screen.spriteTables.patterns + 1]).toBe(0x00);    // left half, row 1
        expect(system.vdp.vram[screen.spriteTables.patterns + 17]).toBe(0xff);   // right half, row 1
    });

    it("reads a bitmap left to right", () => {
        const { sprites, system, screen } = createBios();
        sprites.setPatternFromBitmap(0, ["#.......", "......##", "........", "........", "........", "........", "........", "........"]);
        expect(system.vdp.vram[screen.spriteTables.patterns]).toBe(0x80);
        expect(system.vdp.vram[screen.spriteTables.patterns + 1]).toBe(0x03);
    });

    it("gives each line of a sprite its own colour", () => {
        const { sprites, system, screen } = createBios();
        sprites.setLineColors(0, [1, 2, 3, 4]);
        expect(system.vdp.vram[screen.spriteTables.colors + 0]).toBe(1);
        expect(system.vdp.vram[screen.spriteTables.colors + 3]).toBe(4);
        expect(system.vdp.vram[screen.spriteTables.colors + 4]).toBe(0);
    });

    it("actually reaches the screen", () => {
        const { gfx, sprites, screen, system } = createBios();
        gfx.now.clear(0);
        sprites.setSize(8);
        sprites.setPattern(0, [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
        sprites.set(0, { x: 64, y: 80, pattern: 0, color: 15 });
        sprites.setActiveCount(1);
        screen.frame();

        const frame = system.machine.getFrame()!;
        expect(pixelAt(frame, MODES.G4, 64, 80)).toBe(WHITE);
        expect(pixelAt(frame, MODES.G4, 71, 87)).toBe(WHITE);
        expect(pixelAt(frame, MODES.G4, 72, 88)).not.toBe(WHITE);
    });

    it("stops the chip after the last active sprite", () => {
        const { sprites, system, screen } = createBios();
        sprites.setActiveCount(4);
        expect(system.vdp.vram[screen.spriteTables.attributes + 4 * 4]).toBe(216);
    });
});

describe("Blitter pacing", () => {
    it("spreads a full-screen clear over the frames the chip would need", () => {
        const { gfx, screen } = createBios();
        gfx.now.clear(1);
        gfx.clear(15);

        const done = () => {
            let lines = 0;
            for (let y = 0; y < 212; ++y) if (gfx.getPixel(0, y) === 15) ++lines;
            return lines;
        };

        expect(done()).toBe(0);             // queued, not drawn
        screen.frame();
        const afterOne = done();
        expect(afterOne).toBeGreaterThan(50);
        expect(afterOne).toBeLessThan(212); // and not finished either

        while (gfx.busy) screen.frame();
        expect(done()).toBe(212);
    });

    it("charges eight times as much for a fill that is not byte-aligned", () => {
        const frames = (x: number, width: number) => {
            const { gfx, screen } = createBios();
            gfx.now.clear(0);
            gfx.fillRect(x, 0, width, 40, 5);
            let count = 0;
            while (gfx.busy) { screen.frame(); ++count; }
            return count;
        };
        expect(frames(1, 255)).toBeGreaterThan(frames(0, 256) * 3);
    });

    it("runs jobs in the order they were queued", () => {
        const { gfx, screen } = createBios();
        gfx.now.clear(0);
        gfx.fillRect(0, 0, 64, 64, 4);
        gfx.fillRect(0, 0, 64, 64, 9);      // overwrites the first, and must come second
        expect(gfx.pending).toBe(2);

        while (gfx.busy) screen.frame();
        expect(gfx.getPixel(10, 10)).toBe(9);
    });

    it("pins a job to the page it was queued on", () => {
        const { gfx, screen } = createBios();
        screen.setDrawPage(0);
        gfx.now.clear(0);
        screen.setDrawPage(1);
        gfx.now.clear(0);

        screen.setDrawPage(0);
        gfx.clear(7);                       // queued against page 0
        screen.setDrawPage(1);              // ...then the draw page moves
        while (gfx.busy) screen.frame();

        expect(gfx.getPixel(0, 0, 0)).toBe(7);
        expect(gfx.getPixel(0, 0, 1)).toBe(0);
    });

    it("pins a job to the clip it was queued with", () => {
        const { gfx, screen } = createBios();
        gfx.now.clear(0);
        gfx.setClip(0, 0, 32, 32);
        gfx.fillRect(0, 0, 256, 64, 3);
        gfx.resetClip();                    // widened after queueing, too late for that job
        while (gfx.busy) screen.frame();

        expect(gfx.getPixel(31, 31)).toBe(3);
        expect(gfx.getPixel(32, 31)).toBe(0);
    });

    it("draws nothing more once a queue is abandoned", () => {
        const { gfx, screen } = createBios();
        gfx.now.clear(0);
        gfx.clear(11);
        screen.frame();
        const partial = gfx.getPixel(0, 100);
        gfx.abandon();
        expect(gfx.busy).toBe(false);

        for (let i = 0; i < 4; ++i) screen.frame();
        expect(gfx.getPixel(0, 100)).toBe(partial);
    });

    it("does not bank cycles while the queue is empty", () => {
        const { gfx, screen } = createBios();
        gfx.now.clear(0);
        for (let i = 0; i < 30; ++i) screen.frame();     // half a second of idling

        gfx.clear(2);
        screen.frame();
        expect(gfx.busy).toBe(true);                     // the idle time bought nothing
    });

    it("reports how much work is left", () => {
        const { gfx, screen } = createBios();
        gfx.now.clear(0);
        gfx.clear(6);
        const before = gfx.work;
        expect(before).toBe(256 * 212);
        screen.frame();
        expect(gfx.work).toBeGreaterThan(0);
        expect(gfx.work).toBeLessThan(before);
    });

    it("puts text on screen a line at a time", () => {
        const { gfx, screen } = createBios();
        gfx.now.clear(0);
        gfx.text(0, 0, "HELLO WORLD", 15);
        expect(gfx.busy).toBe(true);
        while (gfx.busy) screen.frame();
        for (let y = 0; y < 7; ++y) expect(gfx.getPixel(0, y)).toBe(15);   // stem of the H
    });
});

describe("Blitter speed", () => {
    it("takes proportionally longer when slowed down", () => {
        const frames = (speed: number) => {
            const { gfx, screen } = createBios();
            gfx.speed = speed;
            gfx.now.clear(0);
            gfx.fillRect(0, 0, 256, 212, 5);
            let count = 0;
            while (gfx.busy) { screen.frame(); ++count; }
            return count;
        };
        // Four times slower, give or take the frame it gets rounded into.
        const slow = frames(0.25);
        const normal = frames(1);
        expect(slow).toBeGreaterThanOrEqual(normal * 3);
        expect(slow).toBeLessThanOrEqual(normal * 5);
    });

    it("refuses a speed that would stall the queue forever", () => {
        const { gfx } = createBios();
        expect(() => { gfx.speed = 0; }).toThrow(RangeError);
        expect(() => { gfx.speed = -1; }).toThrow(RangeError);
        expect(gfx.speed).toBe(1);
    });
});

describe("Screen modes with different page sizes", () => {
    it("moves the sprite tables into the tail of the new page", () => {
        const { screen } = createBios();
        // SCREEN 5 pages are 0x8000; the image uses 0x6A00 of that.
        expect(screen.spriteTables).toEqual({ colors: 0x7400, attributes: 0x7600, patterns: 0x7800 });

        // SCREEN 7 pages are twice as long, so the tables move with them -
        // left where they were they would sit inside the picture.
        screen.setMode("G6");
        expect(screen.spriteTables).toEqual({ colors: 0xf400, attributes: 0xf600, patterns: 0xf800 });
        expect(screen.spriteTables.colors).toBeGreaterThan(screen.height * screen.mode.bytesPerLine);
    });

    it("flips pages in an interleaved mode, where R2 is shifted differently", () => {
        const { screen, gfx, system } = createBios();
        screen.setMode("G6");
        screen.frame();

        expect(screen.mode.pages).toBe(2);
        expect(system.vdp.read(R.LAYOUT_TABLE)).toBe(0x1f);
        screen.setDisplayPage(1);
        expect(system.vdp.read(R.LAYOUT_TABLE)).toBe(0x3f);
        expect(screen.pageBase(1)).toBe(0x10000);

        screen.setDrawPage(1);
        gfx.now.clear(9);
        expect(system.vdp.vram[0x10000]).toBe(0x99);
        expect(system.vdp.vram[0x00000]).not.toBe(0x99);
    });

    it("widens the default clip when the mode gets wider", () => {
        const { screen, gfx } = createBios();
        expect(gfx.clip.width).toBe(256);

        screen.setMode("G6");
        expect(gfx.clip.width).toBe(512);

        // Painting the far right of a SCREEN 7 line has to reach VRAM.
        gfx.now.clear(0);
        gfx.now.pixel(511, 3, 12);
        expect(gfx.getPixel(511, 3)).toBe(12);
    });

    it("keeps an explicit clip across a mode change", () => {
        const { screen, gfx } = createBios();
        gfx.setClip(0, 0, 100, 100);
        screen.setMode("G6");
        expect(gfx.clip.width).toBe(100);
        gfx.resetClip();
        expect(gfx.clip.width).toBe(512);
    });
});
