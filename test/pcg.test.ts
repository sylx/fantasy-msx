import { describe, expect, it } from "vitest";
import { createSystem, NameBuffer, parseMulticolor, parsePattern, type System } from "../src/api/index.js";
import { createBios } from "../src/bios/index.js";
import { pixelAt } from "./helpers.js";

/** A bare machine in a character mode, on the layout `vdp.setMode` gives. */
function system(mode: "G1" | "G2" | "G3"): System {
    const s = createSystem();
    s.vdp.setMode(mode);
    s.vdp.setDisplayEnabled(true);
    s.vdp.vram.fill(0);
    s.vdp.vram[s.vdp.tables.spriteAttributes + (mode === "G3" ? 512 : 0)] = mode === "G3" ? 216 : 208;
    s.vdp.setBackdrop(1);
    s.machine.frame();
    return s;
}

function shown(s: System, x: number, y: number): number {
    return pixelAt(s.machine.getFrame()!, s.vdp.mode, x, y);
}

function swatch(s: System, color: number): number {
    s.vdp.setBackdrop(color);
    s.machine.frame();
    const value = pixelAt(s.machine.getFrame()!, s.vdp.mode, -4, 0);
    s.vdp.setBackdrop(1);
    return value;
}

describe("pattern bitmaps", () => {
    it("read a one-colour bitmap as bits, anything but space and . set", () => {
        expect(parsePattern(["#.#.#.#.", " XX", "11111111"])).toEqual([0xaa, 0x60, 0xff, 0, 0, 0, 0, 0]);
    });

    it("split a coloured bitmap into bits and a colour pair a row", () => {
        const { rows, colors } = parseMulticolor([
            "44444444",         // one colour: set, on the backdrop
            "4ffffff4",         // two: the rarer one is set
            "..7777..",         // with 0: 0 is always the background
            "........"
        ]);
        expect(rows.slice(0, 4)).toEqual([0xff, 0x81, 0x3c, 0x00]);
        expect(colors.slice(0, 4)).toEqual([0x40, 0x4f, 0x70, 0x00]);
    });

    it("name the row that has three colours", () => {
        expect(() => parseMulticolor(["........", "123....."])).toThrow(/row 1 has more than two colours/);
    });

    it("take a palette for characters that are not hex digits", () => {
        expect(parseMulticolor(["##oooooo"], { "#": 15, o: 8 }).colors[0]).toBe(0xf8);
    });
});

describe("the PCG on the chip's own layout", () => {
    it("defines a one-colour character and shows it", () => {
        const s = system("G1");
        s.pcg.define(65, ["########", "........"], 10, 4);
        s.pcg.put(2, 1, 65);
        const yellow = swatch(s, 10), blue = swatch(s, 4);
        s.machine.frame();
        expect(shown(s, 16, 8)).toBe(yellow);
        expect(shown(s, 16, 9)).toBe(blue);
        expect(s.vdp.vram[s.vdp.tables.layout + 32 + 2]).toBe(65);
    });

    it("keeps to three banks where the name table sits in the fourth", () => {
        const s = system("G2");
        expect(s.vdp.tables.layout).toBe(0x1800);   // inside the pattern table's fourth bank
        expect(s.pcg.banks).toBe(3);
        s.pcg.put(0, 0, 7);
        s.pcg.defineMulticolor(0, ["ffffffff"]);
        expect(s.pcg.get(0, 0)).toBe(7);            // not overwritten by bank 3's pattern 0
        expect(() => s.pcg.setPattern(0, [], 3)).toThrow(/there are 3/);
    });

    it("colours a row at a time in G2, and refuses to in G1", () => {
        const s = system("G2");
        s.pcg.defineMulticolor(1, ["22222222", "33333333"]);
        s.pcg.put(0, 0, 1);
        const green = swatch(s, 2), light = swatch(s, 3);
        s.machine.frame();
        expect(shown(s, 0, 0)).toBe(green);
        expect(shown(s, 0, 1)).toBe(light);
        expect(() => system("G1").pcg.setRowColors(0, [0x10])).toThrow(/G1 colours eight characters/);
    });

    it("refuses a bitmap mode", () => {
        const s = createSystem();
        s.vdp.setMode("G4");
        expect(() => s.pcg.put(0, 0, 1)).toThrow(/not a character mode/);
    });
});

describe("a name table in RAM", () => {
    it("is built up and lands on the screen whole", () => {
        const s = system("G3");
        const frame = new NameBuffer();
        frame.clear(0);
        frame.print(1, 1, "HI\nYO");
        frame.fill(0, 23, 32, 1, 9);
        s.pcg.transfer(frame);
        const base = s.vdp.tables.layout;
        expect(s.vdp.vram[base + 33]).toBe(72);
        expect(s.vdp.vram[base + 65]).toBe(89);
        expect(s.vdp.vram[base + 23 * 32 + 31]).toBe(9);
    });

    it("shifts a cell at a time, filling the gap", () => {
        const grid = new NameBuffer(4, 2);
        grid.putMap(0, 0, ["ABCD", "EFGH"]);
        grid.shift(-1, 0, 46);
        expect(String.fromCharCode(...grid.cells)).toBe("BCD.FGH.");
        grid.shift(0, 1, 46);
        expect(String.fromCharCode(...grid.cells)).toBe("....BCD.");
    });

    it("wraps positions round the grid", () => {
        const grid = new NameBuffer(4, 2);
        grid.clear(0);
        grid.print(3, 1, "XY");
        expect(grid.get(3, 1)).toBe(88);
        expect(grid.get(0, 1)).toBe(89);
    });

    it("goes to the page being drawn on through the BIOS", () => {
        const { tiles, screen, system: s } = createBios();
        screen.setMode("G1");
        screen.useDoubleBuffer();
        const frame = new NameBuffer();
        frame.clear(65);
        tiles.transfer(frame);
        expect(s.vdp.vram[screen.pageBase(1)]).toBe(65);
        expect(s.vdp.vram[screen.pageBase(0)]).not.toBe(65);
    });
});
