import { describe, expect, it } from "vitest";
import { R, S } from "../src/api/index.js";
import { createBios, type Bios } from "../src/bios/index.js";
import { pixelAt } from "./helpers.js";

/** SCREEN 5 with every page cleared to colour 0 and the palette's 15 as ink. */
function machine(): Bios {
    const bios = createBios();
    bios.system.vdp.vram.fill(0, 0, 0x7400);
    bios.system.vdp.vram.fill(0, 0x8000, 0x20000);
    return bios;
}

/** A one-pixel column down the whole of a page, in `color`. */
function column(bios: Bios, page: number, x: number, color: number): void {
    const vram = bios.system.vdp.vram;
    for (let y = 0; y < 256; ++y) {
        const at = page * 0x8000 + y * 128 + (x >> 1);
        if (at >= 0x7400 && at < 0x8000) continue;           // the sprite tables
        vram[at] = x & 1 ? (vram[at] & 0xf0) | color : (vram[at] & 0x0f) | (color << 4);
    }
}

/** A one-pixel row across a page, in `color`. */
function row(bios: Bios, page: number, y: number, color: number): void {
    bios.system.vdp.vram.fill(color * 0x11, page * 0x8000 + y * 128, page * 0x8000 + y * 128 + 128);
}

function shown(bios: Bios, x: number, y: number): number {
    bios.screen.frame();
    return pixelAt(bios.system.machine.getFrame()!, bios.screen.mode, x, y);
}

/** Screen columns on line `y` holding the same colour as the ink at (inkX, inkY) of the reference frame. */
function inkColumns(bios: Bios, y: number, ink: number): number[] {
    const frame = bios.system.machine.getFrame()!;
    const found: number[] = [];
    for (let x = 0; x < 256; ++x) if (pixelAt(frame, bios.screen.mode, x, y) === ink) found.push(x);
    return found;
}

function inkRows(bios: Bios, x: number, ink: number): number[] {
    const frame = bios.system.machine.getFrame()!;
    const found: number[] = [];
    for (let y = 0; y < 212; ++y) if (pixelAt(frame, bios.screen.mode, x, y) === ink) found.push(y);
    return found;
}

/** What colour 15 looks like once rendered. */
function inkOf(bios: Bios, color = 15): number {
    const vram = bios.system.vdp.vram;
    const saved = vram[0];
    vram[0] = color << 4;
    const ink = shown(bios, 0, 0);
    vram[0] = saved;
    return ink;
}

describe("the VDP", () => {
    it("identifies itself as a V9958", () => {
        const { system } = createBios();
        expect((system.vdp.status(S.STATUS) >> 1) & 0x1f).toBe(2);
    });
});

describe("vertical scroll", () => {
    it("starts the display on line y of the page, wrapping at 256", () => {
        const bios = machine();
        const ink = inkOf(bios);
        row(bios, 0, 50, 15);

        bios.scroll.y = 20;
        shown(bios, 0, 0);
        expect(inkRows(bios, 10, ink)).toEqual([30]);

        bios.scroll.y = -10;                                  // 246: line 50 is 60 lines down
        shown(bios, 0, 0);
        expect(inkRows(bios, 10, ink)).toEqual([60]);
    });

    it("leaves R23 alone until it is used", () => {
        const bios = machine();
        bios.system.vdp.setVerticalOffset(33);
        bios.screen.frame();
        expect(bios.system.vdp.read(R.VERTICAL_OFFSET)).toBe(33);
    });

    it("is what screen.setScroll sets", () => {
        const bios = machine();
        bios.screen.setScroll(12);
        expect(bios.scroll.y).toBe(12);
        bios.screen.frame();
        expect(bios.system.vdp.read(R.VERTICAL_OFFSET)).toBe(12);
    });
});

describe("horizontal scroll", () => {
    it("starts the display on column x of the page, to the pixel", () => {
        const bios = machine();
        const ink = inkOf(bios);
        column(bios, 0, 100, 15);

        for (const x of [0, 1, 7, 8, 9, 40, 90]) {
            bios.scroll.x = x;
            shown(bios, 0, 0);
            expect(inkColumns(bios, 50, ink)).toEqual([100 - x]);
        }
    });

    it("shows the backdrop where the fine shift has pushed the picture right", () => {
        const bios = machine();
        const ink = inkOf(bios);
        column(bios, 0, 100, 15);
        // Coarse scroll 13 bytes-of-eight (column 104), shifted right 7: column
        // 100 would be at screen column 3, but the chip never fetched it.
        bios.scroll.x = 97;
        shown(bios, 0, 0);
        expect(inkColumns(bios, 50, ink)).toEqual([]);
    });

    it("wraps within one page", () => {
        const bios = machine();
        const ink = inkOf(bios);
        column(bios, 0, 10, 15);
        bios.scroll.x = 200;
        shown(bios, 0, 0);
        expect(inkColumns(bios, 50, ink)).toEqual([66]);
    });

    it("runs across two pages when wide", () => {
        const bios = machine();
        const white = inkOf(bios, 15);
        const red = inkOf(bios, 8);
        column(bios, 0, 10, 15);                              // plane column 10
        column(bios, 1, 30, 8);                               // plane column 286

        bios.scroll.wide = true;
        expect(bios.scroll.planeWidth).toBe(512);

        bios.scroll.x = 260;
        shown(bios, 0, 0);
        expect(inkColumns(bios, 50, red)).toEqual([26]);
        expect(inkColumns(bios, 50, white)).toEqual([]);

        bios.scroll.x = 500;                                  // the right page, then back round to the left
        shown(bios, 0, 0);
        expect(inkColumns(bios, 50, white)).toEqual([22]);
    });

    it("masks the leftmost eight columns", () => {
        const bios = machine();
        const ink = inkOf(bios);
        column(bios, 0, 5, 15);
        column(bios, 0, 20, 15);
        bios.scroll.mask = true;
        shown(bios, 0, 0);
        expect(inkColumns(bios, 50, ink)).toEqual([20]);
    });
});

describe("bands", () => {
    it("change the scroll partway down the screen", () => {
        const bios = machine();
        const ink = inkOf(bios);
        column(bios, 0, 100, 15);

        bios.scroll.x = 40;
        bios.scroll.split(100, { x: 0 });
        bios.scroll.split(150, { x: 90 });
        shown(bios, 0, 0);

        expect(inkColumns(bios, 0, ink)).toEqual([60]);
        expect(inkColumns(bios, 99, ink)).toEqual([60]);
        expect(inkColumns(bios, 100, ink)).toEqual([100]);
        expect(inkColumns(bios, 149, ink)).toEqual([100]);
        expect(inkColumns(bios, 150, ink)).toEqual([10]);
        expect(inkColumns(bios, 211, ink)).toEqual([10]);
    });

    it("each take their own vertical offset", () => {
        const bios = machine();
        const ink = inkOf(bios);
        row(bios, 0, 120, 15);

        bios.scroll.y = 0;
        const lower = bios.scroll.split(100, { y: 0 });
        shown(bios, 0, 0);
        expect(inkRows(bios, 10, ink)).toEqual([120]);

        lower.y = 15;                                         // screen line 105 now shows line 120
        shown(bios, 0, 0);
        expect(inkRows(bios, 10, ink)).toEqual([105]);
    });

    it("can be one line tall", () => {
        const bios = machine();
        const ink = inkOf(bios);
        column(bios, 0, 100, 15);
        for (let line = 50; line < 60; ++line) bios.scroll.split(line, { x: line - 50 });
        bios.scroll.split(60, { x: 0 });
        shown(bios, 0, 0);
        for (let line = 50; line < 60; ++line) expect(inkColumns(bios, line, ink)).toEqual([100 - (line - 50)]);
        expect(inkColumns(bios, 60, ink)).toEqual([100]);
    });

    it("can show another page", () => {
        const bios = machine();
        const white = inkOf(bios, 15);
        const red = inkOf(bios, 8);
        column(bios, 0, 40, 15);
        column(bios, 2, 40, 8);

        bios.scroll.split(80, { page: 2 });
        shown(bios, 0, 0);
        expect(inkColumns(bios, 79, white)).toEqual([40]);
        expect(inkColumns(bios, 80, red)).toEqual([40]);
        expect(inkColumns(bios, 80, white)).toEqual([]);
    });

    it("come back the same every frame", () => {
        const bios = machine();
        const ink = inkOf(bios);
        column(bios, 0, 100, 15);
        bios.scroll.x = 20;
        bios.scroll.split(100, { x: 0 });
        for (let i = 0; i < 3; ++i) {
            shown(bios, 0, 0);
            expect(inkColumns(bios, 10, ink)).toEqual([80]);
            expect(inkColumns(bios, 150, ink)).toEqual([100]);
        }
    });

    it("go away with unsplit", () => {
        const bios = machine();
        const ink = inkOf(bios);
        column(bios, 0, 100, 15);
        bios.scroll.x = 20;
        bios.scroll.split(100, { x: 0 });
        bios.scroll.unsplit();
        shown(bios, 0, 0);
        expect(inkColumns(bios, 150, ink)).toEqual([80]);
        expect(bios.scroll.bands).toHaveLength(1);
    });

    it("say where a screen pixel is in the plane", () => {
        const bios = machine();
        bios.scroll.set(250, 10);
        bios.scroll.split(100, { x: 0, y: 200 });
        expect(bios.scroll.toPlane(10, 5)).toEqual({ x: 4, y: 15 });
        expect(bios.scroll.toPlane(10, 120)).toEqual({ x: 10, y: 64 });
    });
});

describe("sprites under a scroll", () => {
    it("stay on the screen line they were placed on", () => {
        const bios = machine();
        const { sprites, scroll, screen } = bios;
        const attributes = screen.spriteTables.attributes;
        const vram = bios.system.vdp.vram;

        sprites.set(0, { x: 10, y: 50, pattern: 0, color: 15 });
        expect(vram[attributes]).toBe(49);

        scroll.y = 30;
        screen.frame();
        expect(vram[attributes]).toBe(79);

        // A band further down with its own offset takes the sprites in it.
        scroll.split(100, { y: 0 });
        sprites.move(0, 10, 120);
        expect(vram[attributes]).toBe(119);
    });

    it("never land on the Y that ends the list", () => {
        const bios = machine();
        bios.scroll.y = 3;
        bios.sprites.hide(0);                                 // 213 + 3 would be 216
        expect(bios.system.vdp.vram[bios.screen.spriteTables.attributes]).not.toBe(216);
    });

    it("hide where no band is looking", () => {
        const bios = machine();
        const { sprites, scroll, screen } = bios;
        const y = () => bios.system.vdp.vram[screen.spriteTables.attributes];

        sprites.hide(0);
        expect(y()).toBe(213);                                // below the screen, as it always was

        // A band pointing the bottom of the screen at page lines 212 and on: a
        // sprite parked there would show in it, and wrapping round, in the top.
        scroll.split(180, { y: 40 });
        sprites.hide(0);
        const top = (y() + 1) & 0xff;
        for (let line = 0; line < 16; ++line) {
            const shown = (top + line) & 0xff;
            expect(shown < 180 || (shown >= 220 && shown < 252)).toBe(false);
        }
    });

    it("leave the end of the list where it was put", () => {
        const bios = machine();
        bios.sprites.setActiveCount(2);
        bios.scroll.y = 40;
        bios.screen.frame();
        expect(bios.system.vdp.vram[bios.screen.spriteTables.attributes + 8]).toBe(216);
    });
});
