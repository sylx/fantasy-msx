import { describe, expect, it } from "vitest";
import { R } from "../src/api/index.js";
import { createBios, PATTERN_TABLES, type Bios } from "../src/bios/index.js";
import { pixelAt } from "./helpers.js";

/** A machine in a character mode, its VRAM cleared, and the frame that sets the geometry run. */
function machine(mode: "G1" | "G2" | "G3"): Bios {
    const bios = createBios();
    bios.screen.setMode(mode);
    bios.system.vdp.vram.fill(0);
    bios.sprites.hideAll();
    bios.screen.setBackdrop(1);
    bios.screen.frame();
    return bios;
}

/** What a palette entry looks like once rendered, read off the border. */
function swatch(bios: Bios, color: number): number {
    const vdp = bios.system.vdp;
    const saved = vdp.read(R.COLOR);
    vdp.setBackdrop(color);
    bios.screen.frame();
    const value = pixelAt(bios.system.machine.getFrame()!, bios.screen.mode, -4, 0);
    vdp.setBackdrop(saved);
    return value;
}

function shown(bios: Bios, x: number, y: number): number {
    return pixelAt(bios.system.machine.getFrame()!, bios.screen.mode, x, y);
}

const SOLID = ["88888888", "88888888", "88888888", "88888888", "88888888", "88888888", "88888888", "88888888"];

describe("the character modes", () => {
    it("put their tables where the tiles expect them", () => {
        for (const mode of ["G1", "G2", "G3"] as const) {
            const { screen, system } = createBios();
            screen.setMode(mode);
            expect(system.vdp.tables.layout).toBe(PATTERN_TABLES.names);
            expect(system.vdp.tables.patterns).toBe(PATTERN_TABLES.patterns);
            expect(system.vdp.tables.colors).toBe(PATTERN_TABLES.colors);
        }
    });

    it("show a character in SCREEN 1, coloured by its group of eight", () => {
        const bios = machine("G1");
        const { tiles, screen } = bios;
        tiles.setPattern(65, [0xff, 0, 0xff, 0, 0xff, 0, 0xff, 0]);
        tiles.setColor(65, 10, 4);
        tiles.put(3, 2, 65);
        screen.frame();

        const yellow = swatch(bios, 10), blue = swatch(bios, 4);
        screen.frame();
        expect(shown(bios, 3 * 8, 2 * 8)).toBe(yellow);
        expect(shown(bios, 3 * 8 + 7, 2 * 8 + 1)).toBe(blue);
        // The colour belongs to codes 64-71 together.
        expect(system(bios)[PATTERN_TABLES.colors + 8]).toBe(0xa4);
    });

    it("prints with the machine's font", () => {
        const bios = machine("G1");
        const { tiles, screen } = bios;
        tiles.loadFont({ foreground: 15, background: 1 });
        tiles.clear();
        tiles.print(0, 0, "I");
        screen.frame();
        const white = swatch(bios, 15);
        screen.frame();
        // "I" is a column down the middle of its five pixels, one pixel in.
        expect(shown(bios, 3, 0)).toBe(white);
        expect(shown(bios, 0, 0)).not.toBe(white);
        expect(tiles.get(0, 0)).toBe(73);
        expect(tiles.get(1, 0)).toBe(32);
    });

    it("colour each row separately in SCREEN 2 and 4", () => {
        for (const mode of ["G2", "G3"] as const) {
            const bios = machine(mode);
            const { tiles, screen } = bios;
            tiles.define(1, ["22222222", "33333333", "2.2.2.2.", "........", "", "", "", ""]);
            tiles.put(0, 0, 1);
            screen.frame();
            const green = swatch(bios, 2), light = swatch(bios, 3), backdrop = swatch(bios, 1);
            screen.frame();
            expect(shown(bios, 0, 0)).toBe(green);
            expect(shown(bios, 0, 1)).toBe(light);
            expect(shown(bios, 0, 2)).toBe(green);
            expect(shown(bios, 1, 2)).toBe(backdrop);       // colour 0 is a hole
            expect(shown(bios, 0, 3)).toBe(backdrop);
        }
    });

    it("refuses a row of three colours", () => {
        const { tiles, screen } = createBios();
        screen.setMode("G3");
        expect(() => tiles.define(0, ["12300000"])).toThrow(/row 0 has more than two colours/);
    });

    it("keeps a bank for each third of the screen", () => {
        const bios = machine("G3");
        const { tiles, screen } = bios;
        tiles.define(5, SOLID, { bank: 1 });
        tiles.put(0, 0, 5);         // bank 0: nothing defined
        tiles.put(0, 8, 5);         // bank 1
        screen.frame();
        const red = swatch(bios, 8);
        screen.frame();
        expect(shown(bios, 0, 0)).not.toBe(red);
        expect(shown(bios, 0, 64)).toBe(red);
    });

    it("scrolls down into the rows below the screen, drawn from the fourth bank", () => {
        const bios = machine("G2");
        const { tiles, screen, scroll } = bios;
        tiles.define(5, SOLID, { bank: 3 });
        tiles.put(0, 28, 5);
        scroll.y = 28 * 8;
        screen.frame();
        const red = swatch(bios, 8);
        screen.frame();
        expect(shown(bios, 0, 0)).toBe(red);
    });

    it("flip name tables, patterns shared", () => {
        const bios = machine("G1");
        const { tiles, screen } = bios;
        tiles.define(8, SOLID);
        screen.useDoubleBuffer();
        tiles.put(0, 0, 8);         // on the hidden table
        screen.frame();
        const red = swatch(bios, 8);
        screen.frame();
        expect(shown(bios, 0, 0)).not.toBe(red);
        screen.flip();
        screen.frame();
        expect(shown(bios, 0, 0)).toBe(red);
    });

    it("scroll across two name tables with the V9958", () => {
        const bios = machine("G3");
        const { tiles, screen, scroll } = bios;
        tiles.define(8, SOLID);
        scroll.wide = true;
        tiles.put(40, 0, 8);        // the right-hand table of the pair
        expect(system(bios)[screen.pageBase(1)] | system(bios)[screen.pageBase(1) + 8]).toBe(8);
        scroll.x = 256;
        screen.frame();
        const red = swatch(bios, 8);
        screen.frame();
        expect(shown(bios, 64, 0)).toBe(red);
    });

    it("refuse to work outside G1, G2 and G3", () => {
        const { tiles } = createBios();
        expect(() => tiles.put(0, 0, 1)).toThrow(/not a character mode/);
    });

    it("stop gfx drawing over the characters", () => {
        const { gfx, screen } = createBios();
        screen.setMode("G1");
        expect(() => gfx.fillRect(0, 0, 8, 8, 1)).toThrow(/no framebuffer/);
    });
});

describe("sprites in the character modes", () => {
    it("use sprite mode 1 in SCREEN 1: one colour, in the attribute table", () => {
        const bios = machine("G1");
        const { sprites, screen } = bios;
        sprites.setSize(8);
        sprites.setPattern(0, [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
        sprites.set(0, { x: 100, y: 50, pattern: 0, color: [12, 3, 3, 3, 3, 3, 3, 3] });
        screen.frame();
        const green = swatch(bios, 12);
        screen.frame();
        expect(shown(bios, 100, 50)).toBe(green);
        expect(shown(bios, 100, 57)).toBe(green);
        expect(system(bios)[screen.spriteTables.attributes + 3]).toBe(12);
    });

    it("refuse a multicolour pair in sprite mode 1", () => {
        const { sprites, screen } = createBios();
        screen.setMode("G2");
        const pattern = sprites.setMulticolorPattern(0, ["12"]);
        expect(() => sprites.setMulticolor(0, { x: 0, y: 0, pattern })).toThrow(/sprite mode 1/);
    });

    it("keep sprite mode 2 in SCREEN 4", () => {
        const bios = machine("G3");
        const { sprites, screen } = bios;
        sprites.setSize(8);
        sprites.setPattern(0, [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
        sprites.set(0, { x: 100, y: 50, pattern: 0, color: [12, 3, 3, 3, 3, 3, 3, 3] });
        screen.frame();
        const green = swatch(bios, 12), light = swatch(bios, 3);
        screen.frame();
        expect(shown(bios, 100, 50)).toBe(green);
        expect(shown(bios, 100, 51)).toBe(light);
    });
});

function system(bios: Bios): Uint8Array {
    return bios.system.vdp.vram;
}
