// Characters: the pattern modes, SCREEN 1, 2 and 4.
//
// Before the MSX2 had a framebuffer, a screen was 32x24 character codes, and
// what a code looked like was eight bytes of pattern the program was free to
// rewrite - the PCG, the programmable character generator. A whole screen is
// 768 bytes, so it changes in one frame with no blitter at all, and a pattern
// redefined changes every cell that uses it at once. That is why the MSX1's
// games are made of it, and why it is still the cheap way to fill a screen.
//
// The three modes differ in where the colour lives:
//
//   G1 (SCREEN 1)  256 patterns, and one colour pair for each group of eight
//                  codes: 0-7 share one, 8-15 the next. Few colours, but a
//                  pattern is all it takes to make a character.
//   G2 (SCREEN 2)  A colour pair for every row of every character - the
//                  "multicolour" PCG. The screen is cut into thirds, each with
//                  its own 256 patterns and colours: a bank. Sprite mode 1.
//   G3 (SCREEN 4)  G2's characters with the MSX2's sprites, eight to a line
//                  and a colour a line. On a V9938 there is little reason to
//                  choose G2 over it.
//
// Each row of a character is two colours, one for its set bits and one for
// the rest. Colour 0 is not black but a hole: the backdrop shows through it.
//
// A vertical scroll carries on past the 24 rows the screen shows: the name
// table is 32 rows deep, the 256 lines R23 goes round, and in G2 and G3 the
// last 8 of them use a fourth bank. So there are four banks here, not three.

import type { Vdp } from "../api/index.js";
import { FONT, glyphOffset } from "./font.js";
import { isPatternMode, PATTERN_TABLES, type Screen } from "./screen.js";

/** Characters across a name table, and down it - the whole plane, not just the screen. */
export const TILE_COLUMNS = 32;
export const TILE_ROWS = 32;
/** Rows of characters a bank covers in G2 and G3. The fourth only a scroll shows. */
const BANK_ROWS = 8;
const BANKS = 4;

export interface TileOptions {
    /**
     * G2 and G3: the bank to write, 0-3, which is the third of the screen the
     * character is shown in (and the 8 rows below it that only a scroll
     * reaches). Left out, every bank gets the same, and the character looks
     * the same wherever it is put. G1 has one bank and ignores this.
     */
    bank?: number;
}

export interface DefineOptions extends TileOptions {
    /** What a character in the bitmap stands for. Otherwise hex digits are colours and space or "." is 0. */
    palette?: Readonly<Record<string, number>>;
}

export interface FontOptions extends TileOptions {
    foreground?: number;
    background?: number;
}

export class Tiles {
    private readonly vram: Uint8Array;

    constructor(private readonly vdp: Vdp, private readonly screen: Screen) {
        this.vram = vdp.vram;
    }

    /** Characters across the plane: 32, or 64 when the scroll is `wide`. */
    get columns(): number {
        return this.screen.scroll.wide ? TILE_COLUMNS * 2 : TILE_COLUMNS;
    }

    /** Characters down the plane: 32. The screen shows 24 of them. */
    get rows(): number {
        return TILE_ROWS;
    }

    /** How many banks of patterns and colours there are: 4 in G2 and G3, 1 in G1. */
    get banks(): number {
        return this.vdp.mode.name === "G1" ? 1 : BANKS;
    }

    // --- Patterns and colours ---------------------------------------------

    /** Loads a character's shape: 8 rows, bit 7 leftmost. Its colours are left as they are. */
    setPattern(code: number, rows: ArrayLike<number>, options: TileOptions = {}): void {
        this.require();
        for (const bank of this.banksOf(options)) {
            const at = PATTERN_TABLES.patterns + bank * 0x800 + (code & 0xff) * 8;
            for (let y = 0; y < 8; ++y) this.vram[at + y] = (rows[y] ?? 0) & 0xff;
        }
    }

    /**
     * Colours a character: `foreground` for its set bits, `background` for the
     * rest. In G1 colour belongs to eight codes together, so this colours
     * `code & ~7` to `code | 7` - all of them, not just the one.
     */
    setColor(code: number, foreground: number, background = 0, options: TileOptions = {}): void {
        this.require();
        const pair = colorPair(foreground, background);
        if (this.vdp.mode.name === "G1") {
            this.vram[PATTERN_TABLES.colors + ((code & 0xff) >> 3)] = pair;
            return;
        }
        this.setRowColors(code, [pair, pair, pair, pair, pair, pair, pair, pair], options);
    }

    /**
     * G2 and G3: a colour pair for each of a character's 8 rows, as the bytes
     * the colour table holds - foreground in the high nibble, background in the
     * low. G1 has no such thing and throws.
     */
    setRowColors(code: number, colors: ArrayLike<number>, options: TileOptions = {}): void {
        this.require();
        if (this.vdp.mode.name === "G1") {
            throw new Error("G1 colours eight characters at a time, not a row at a time - use setColor, or G2 or G3");
        }
        for (const bank of this.banksOf(options)) {
            const at = PATTERN_TABLES.colors + bank * 0x800 + (code & 0xff) * 8;
            for (let y = 0; y < 8; ++y) this.vram[at + y] = (colors[y] ?? 0) & 0xff;
        }
    }

    /**
     * Defines a character from a bitmap drawn in colours: 8 strings of 8, a
     * hex digit per pixel (or whatever `palette` maps), with space and "." for
     * colour 0, the backdrop.
     *
     * Each row may use two colours, and that is the chip's rule rather than
     * this function's - a row with three throws, naming it. In G1 the rule is
     * two for the whole character, and they become the colours of its group of
     * eight, so the last of a group to be defined decides them - unless it is
     * all colour 0, which leaves them be.
     */
    define(code: number, bitmap: readonly string[], options: DefineOptions = {}): void {
        this.require();
        const pixels = bitmap.slice(0, 8).map((row, y) => {
            const line: number[] = [];
            for (let x = 0; x < 8; ++x) line.push(colorOf(row[x] ?? ".", options.palette ?? {}, code, y, x));
            return line;
        });
        while (pixels.length < 8) pixels.push([0, 0, 0, 0, 0, 0, 0, 0]);

        if (this.vdp.mode.name === "G1") {
            const [fg, bg] = pairFor(pixels.flat(), () => `character ${code} has more than two colours; G1 gives a character two, shared by its group of eight`);
            this.setPattern(code, pixels.map((line) => bitsOf(line, fg, bg)));
            // A blank character has no colours to give its group.
            if (fg !== 0 || bg !== 0) this.setColor(code, fg, bg);
            return;
        }
        const rows: number[] = [], colors: number[] = [];
        for (let y = 0; y < 8; ++y) {
            const [fg, bg] = pairFor(pixels[y]!, () => `character ${code}: row ${y} has more than two colours; a row gets two`);
            rows.push(bitsOf(pixels[y]!, fg, bg));
            colors.push(colorPair(fg, bg));
        }
        this.setPattern(code, rows, options);
        this.setRowColors(code, colors, options);
    }

    /**
     * Loads the machine's own font into codes 32-126, so `print` has something
     * to show. In G1 that colours groups 4 to 15 as well: every code from 32
     * to 127.
     */
    loadFont(options: FontOptions = {}): void {
        this.require();
        const fg = options.foreground ?? 15, bg = options.background ?? 0;
        const rows = new Array<number>(8);
        for (let code = 32; code < 127; ++code) {
            const glyph = glyphOffset(code);
            // Five pixels wide: one column in from the left, two spare on the right.
            for (let y = 0; y < 8; ++y) rows[y] = FONT[glyph + y] >> 1;
            this.setPattern(code, rows, options);
            if (this.vdp.mode.name !== "G1") this.setColor(code, fg, bg, options);
        }
        if (this.vdp.mode.name === "G1") for (let code = 32; code < 128; code += 8) this.setColor(code, fg, bg);
    }

    // --- The name table -----------------------------------------------------
    //
    // These write the page being drawn on, the way `gfx` does, so a screen can
    // be built on a hidden name table and flipped in whole. Positions wrap
    // round the plane.

    /** Puts one character. */
    put(x: number, y: number, code: number): void {
        this.require();
        this.vram[this.address(x, y)] = code & 0xff;
    }

    /** The character at a cell. */
    get(x: number, y: number): number {
        this.require();
        return this.vram[this.address(x, y)];
    }

    /**
     * Puts a run of characters rightwards from (x, y): the codes of a string,
     * or an array of them. A "\n" in a string goes back to `x` a row down.
     */
    print(x: number, y: number, text: string | ArrayLike<number>): void {
        this.require();
        let column = x;
        for (let i = 0; i < text.length; ++i) {
            const code = typeof text === "string" ? text.charCodeAt(i) : text[i]!;
            if (typeof text === "string" && code === 10) { column = x; ++y; continue; }
            this.vram[this.address(column++, y)] = code & 0xff;
        }
    }

    /**
     * Puts a block of characters, one array of codes (or string) per row -
     * a map made elsewhere, say.
     */
    putMap(x: number, y: number, rows: ReadonlyArray<string | ArrayLike<number>>): void {
        for (let row = 0; row < rows.length; ++row) this.print(x, y + row, rows[row]!);
    }

    /** Fills a rectangle of cells with one character. */
    fill(x: number, y: number, width: number, height: number, code: number): void {
        this.require();
        for (let row = 0; row < height; ++row) {
            for (let column = 0; column < width; ++column) this.vram[this.address(x + column, y + row)] = code & 0xff;
        }
    }

    /** Fills the whole name table - all 32 rows of it, and both of a wide pair. */
    clear(code = 32): void {
        this.fill(0, 0, this.columns, TILE_ROWS, code);
    }

    // --- Internals --------------------------------------------------------

    /** VRAM address of a cell of the page being drawn on. */
    private address(x: number, y: number): number {
        const columns = this.columns;
        x = ((Math.round(x) % columns) + columns) % columns;
        y = ((Math.round(y) % TILE_ROWS) + TILE_ROWS) % TILE_ROWS;
        // A wide plane is a pair of name tables, the even one on the left.
        const draw = this.screen.drawPage;
        const page = this.screen.scroll.wide ? (draw & ~1) | (x >> 5) : draw;
        return this.screen.pageBase(page) + y * TILE_COLUMNS + (x & 31);
    }

    private banksOf(options: TileOptions): number[] {
        if (this.vdp.mode.name === "G1") return [0];
        if (options.bank === undefined) return [0, 1, 2, 3];
        if (options.bank < 0 || options.bank >= BANKS) throw new Error(`bank ${options.bank}: there are four, 0-3`);
        return [options.bank];
    }

    private require(): void {
        const name = this.vdp.mode.name;
        if (!isPatternMode(name)) {
            throw new Error(`${name} is not a character mode - tiles need G1, G2 or G3 (SCREEN 1, 2 or 4); call screen.setMode first`);
        }
    }
}

/** Which bank the character at a row of the plane is drawn from, in G2 and G3. */
export function bankOfRow(row: number): number {
    return (((row % TILE_ROWS) + TILE_ROWS) % TILE_ROWS) / BANK_ROWS | 0;
}

function colorPair(foreground: number, background: number): number {
    return ((foreground & 0x0f) << 4) | (background & 0x0f);
}

function colorOf(char: string, palette: Readonly<Record<string, number>>, code: number, y: number, x: number): number {
    const mapped = palette[char];
    if (mapped !== undefined) return mapped & 0x0f;
    if (char === " " || char === ".") return 0;
    const hex = parseInt(char, 16);
    if (Number.isNaN(hex)) throw new Error(`character ${code}: "${char}" at row ${y}, column ${x} is not in the palette or a hex digit`);
    return hex;
}

/**
 * The foreground and background for a set of pixels. Colour 0 is always the
 * background where it appears, so a transparent pixel stays transparent;
 * otherwise the commoner colour is, and the rarer one is drawn as the pattern.
 */
function pairFor(pixels: readonly number[], tooMany: () => string): [number, number] {
    const counts = new Map<number, number>();
    for (const c of pixels) counts.set(c, (counts.get(c) ?? 0) + 1);
    if (counts.size > 2) throw new Error(tooMany());
    const colors = [...counts.keys()];
    if (colors.length === 1) return colors[0] === 0 ? [0, 0] : [colors[0]!, 0];
    let [a, b] = colors as [number, number];
    if (a === 0 || (b !== 0 && counts.get(a)! > counts.get(b)!)) [a, b] = [b, a];
    return [a, b];
}

/** A row of pixels as pattern bits: set where the foreground is. */
function bitsOf(line: readonly number[], fg: number, bg: number): number {
    let bits = 0;
    for (let x = 0; x < 8; ++x) if (line[x] === fg && fg !== bg) bits |= 0x80 >> x;
    return bits;
}
