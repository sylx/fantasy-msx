// Characters: the pattern modes, SCREEN 1, 2 and 4, on the BIOS's layout.
//
// The tables themselves are `system.pcg`'s business (src/api/pcg.ts, which
// also says what G1, G2 and G3 each do with colour). What this adds is the
// screen around them: the name tables are pages, so these calls write the
// page being drawn on, as `gfx` does, and a screen can be built on a hidden
// one and flipped in whole; with the scroll `wide`, a pair of them is one
// plane 64 characters across and addressed as one. And the machine's font.
//
// A frame of characters is cheap enough to rebuild from nothing every time:
// clear a `NameBuffer`, draw everything into it, `transfer` it here. 768
// bytes, no blitter, nothing half-drawn.

import {
    CellGrid, NAME_COLUMNS, NAME_ROWS, isPatternMode,
    type Pcg, type PatternModeName
} from "../api/index.js";
import { FONT, glyphOffset } from "./font.js";
import type { Screen } from "./screen.js";

export interface FontOptions {
    foreground?: number;
    background?: number;
    /** G2 and G3: the one bank to load it into. Left out, all of them. */
    bank?: number;
}

export class Tiles extends CellGrid {
    readonly rows = NAME_ROWS;
    protected readonly data: Uint8Array;

    constructor(private readonly pcg: Pcg, private readonly screen: Screen, vram: Uint8Array) {
        super();
        this.data = vram;
    }

    /** Characters across the plane: 32, or 64 when the scroll is `wide`. */
    get columns(): number {
        return this.screen.scroll.wide ? NAME_COLUMNS * 2 : NAME_COLUMNS;
    }

    /** How many banks of patterns and colours there are: 4 in G2 and G3, 1 in G1. */
    get banks(): number {
        return this.pcg.banks;
    }

    // --- Patterns and colours: see Pcg -------------------------------------

    /** Loads a character's shape: 8 rows, bit 7 leftmost. */
    setPattern(code: number, rows: ArrayLike<number>, bank?: number): void {
        this.pcg.setPattern(code, rows, bank);
    }

    /** Loads many shapes at once, 8 bytes each, from `first` on. */
    setPatterns(first: number, bytes: ArrayLike<number>, bank?: number): void {
        this.pcg.setPatterns(first, bytes, bank);
    }

    /** Colours a character, every row alike. In G1, its whole group of eight. */
    setColor(code: number, foreground: number, background = 0, bank?: number): void {
        this.pcg.setColor(code, foreground, background, bank);
    }

    /** G2 and G3: a colour table byte for each of a character's 8 rows. */
    setRowColors(code: number, colors: ArrayLike<number>, bank?: number): void {
        this.pcg.setRowColors(code, colors, bank);
    }

    /** A one-colour character from a bitmap: anything but space or "." is set. */
    define(code: number, bitmap: readonly string[], foreground: number, background = 0, bank?: number): void {
        this.pcg.define(code, bitmap, foreground, background, bank);
    }

    /** A character from a bitmap in colours, two to a row - two to the character in G1. */
    defineMulticolor(code: number, bitmap: readonly string[], options: { palette?: Readonly<Record<string, number>>; bank?: number } = {}): void {
        this.pcg.defineMulticolor(code, bitmap, options);
    }

    /**
     * Loads the machine's own font into codes 32-126, so `print` has something
     * to show. In G1 that colours groups 4 to 15 as well: every code from 32
     * to 127.
     */
    loadFont(options: FontOptions = {}): void {
        const mode = this.require();
        const fg = options.foreground ?? 15, bg = options.background ?? 0;
        const bytes = new Uint8Array((127 - 32) * 8);
        for (let code = 32; code < 127; ++code) {
            const glyph = glyphOffset(code);
            // Five pixels wide: one column in from the left, two spare on the right.
            for (let y = 0; y < 8; ++y) bytes[(code - 32) * 8 + y] = FONT[glyph + y] >> 1;
        }
        this.pcg.setPatterns(32, bytes, options.bank);
        if (mode === "G1") {
            for (let code = 32; code < 128; code += 8) this.pcg.setColor(code, fg, bg);
        } else {
            for (let code = 32; code < 127; ++code) this.pcg.setColor(code, fg, bg, options.bank);
        }
    }

    // --- Internals --------------------------------------------------------

    /** A cell of the page being drawn on; with a wide plane, of the pair it belongs to. */
    protected index(x: number, y: number): number {
        this.require();
        const draw = this.screen.drawPage;
        const page = this.screen.scroll.wide ? (draw & ~1) | (x >> 5) : draw;
        return this.screen.pageBase(page) + y * NAME_COLUMNS + (x & 31);
    }

    private require(): PatternModeName {
        const name = this.screen.mode.name;
        if (!isPatternMode(name)) {
            throw new Error(`${name} is not a character mode - tiles need G1, G2 or G3 (SCREEN 1, 2 or 4); call screen.setMode first`);
        }
        return name;
    }
}
