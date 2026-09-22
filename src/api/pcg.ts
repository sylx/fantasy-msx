// The pattern modes' tables, by name: SCREEN 1, 2 and 4.
//
// In G1, G2 and G3 the screen is not pixels but 32x24 character codes - the
// name table - and each code is drawn from eight bytes of pattern and its
// colours, which the program is free to redefine: the PCG. Nothing here
// decides where those tables live. It writes wherever R2, R3 and R4 point
// (`vdp.tables`), so the layout `vdp.setMode` gives, the BIOS's, or one of
// your own all work the same.
//
// The whole screen is 768 bytes. A Z80 pushes that through port 0x98 in about
// a third of a frame, and here it is a loop over a typed array - so the natural way
// to drive these modes is to rebuild the screen from scratch every frame in a
// `NameBuffer` and `transfer` it, the way MSX games kept a copy of the name
// table in RAM and blasted it across at VBlank. A bitmap screen is 32 times
// the bytes and needs the blitter to move them.
//
// Colour: every row of a character is two colours, one for its set bits and
// one for the clear ones, and colour 0 is not black but a hole the backdrop
// shows through.
//
//   G1  one colour pair for each group of eight codes (0-7, 8-15, ...)
//   G2  a pair for every row of every character, and the screen cut into
//       thirds, each with 256 patterns of its own: a bank
//   G3  as G2, with sprite mode 2

import type { ScreenModeName } from "./v9938.js";
import type { Vdp } from "./vdp.js";

/** The modes built from 8x8 characters: SCREEN 1, 2 and 4. */
export type PatternModeName = "G1" | "G2" | "G3";

export function isPatternMode(name: ScreenModeName): name is PatternModeName {
    return name === "G1" || name === "G2" || name === "G3";
}

/** Characters across a name table. */
export const NAME_COLUMNS = 32;
/**
 * Rows of a name table: 32, the 256 lines R23 scrolls round. The screen shows
 * 24; the other 8 come into view with a vertical scroll.
 */
export const NAME_ROWS = 32;
/** Rows the screen shows. */
export const SCREEN_ROWS = 24;
/** Character rows a bank covers in G2 and G3. */
export const BANK_ROWS = 8;
/** Bytes of pattern (or of colour) per bank in G2 and G3. */
const BANK_SIZE = 0x800;

/** Which bank the character at a row of the name table is drawn from, in G2 and G3. */
export function bankOfRow(row: number): number {
    return (wrap(row, NAME_ROWS) / BANK_ROWS) | 0;
}

/** A colour table byte: foreground in the high nibble, background in the low. */
export function colorPair(foreground: number, background = 0): number {
    return ((foreground & 0x0f) << 4) | (background & 0x0f);
}

// --- Bitmaps ---------------------------------------------------------------

/**
 * A one-colour bitmap as 8 rows of pattern bits: one string per row, space
 * and "." clear, anything else set. Short rows and missing rows are clear.
 */
export function parsePattern(bitmap: readonly string[]): number[] {
    const rows: number[] = [];
    for (let y = 0; y < 8; ++y) {
        const row = bitmap[y] ?? "";
        let bits = 0;
        for (let x = 0; x < 8 && x < row.length; ++x) if (row[x] !== " " && row[x] !== ".") bits |= 0x80 >> x;
        rows.push(bits);
    }
    return rows;
}

/** A bitmap in colours, as the pattern bits and colour bytes that draw it. */
export interface MulticolorCharacter {
    /** 8 rows of pattern bits, set where the row's foreground is. */
    readonly rows: number[];
    /** 8 colour table bytes, one per row. */
    readonly colors: number[];
}

/**
 * Works out the pattern and row colours for a bitmap drawn in colours: a hex
 * digit a pixel, or whatever `palette` maps, with space and "." for colour 0.
 *
 * Two colours to a row is the chip's rule, and a row with a third throws,
 * naming it. Where colour 0 appears it is the background, so it stays a hole;
 * otherwise the commoner colour is the background and the rarer one is set.
 */
export function parseMulticolor(bitmap: readonly string[], palette: Readonly<Record<string, number>> = {}): MulticolorCharacter {
    const rows: number[] = [], colors: number[] = [];
    for (let y = 0; y < 8; ++y) {
        const line = pixelsOf(bitmap[y] ?? "", palette, y);
        const [fg, bg] = pairFor(line, () => `pattern bitmap: row ${y} has more than two colours; a row gets two`);
        rows.push(bitsOf(line, fg, bg));
        colors.push(colorPair(fg, bg));
    }
    return { rows, colors };
}

// --- Cells -----------------------------------------------------------------

/**
 * A grid of character codes, in VRAM or out of it. Positions wrap round the
 * grid, so a map can be written across the edge of a scrolling plane.
 */
export abstract class CellGrid {
    abstract readonly columns: number;
    abstract readonly rows: number;
    protected abstract readonly data: Uint8Array;
    /** Index into `data` of a cell already wrapped into the grid. */
    protected abstract index(x: number, y: number): number;

    /** Puts one character. */
    put(x: number, y: number, code: number): void {
        this.data[this.at(x, y)] = code & 0xff;
    }

    /** The character at a cell. */
    get(x: number, y: number): number {
        return this.data[this.at(x, y)];
    }

    /**
     * Puts a run of characters rightwards from (x, y): a string's character
     * codes, or an array of codes. A "\n" in a string goes back to `x` a row
     * down.
     */
    print(x: number, y: number, text: string | ArrayLike<number>): void {
        let column = x;
        for (let i = 0; i < text.length; ++i) {
            const code = typeof text === "string" ? text.charCodeAt(i) : text[i]!;
            if (typeof text === "string" && code === 10) { column = x; ++y; continue; }
            this.data[this.at(column++, y)] = code & 0xff;
        }
    }

    /** Puts a block of characters, one string or array of codes per row. */
    putMap(x: number, y: number, rows: ReadonlyArray<string | ArrayLike<number>>): void {
        for (let row = 0; row < rows.length; ++row) {
            const line = rows[row]!;
            for (let i = 0; i < line.length; ++i) {
                const code = typeof line === "string" ? line.charCodeAt(i) : line[i]!;
                this.data[this.at(x + i, y + row)] = code & 0xff;
            }
        }
    }

    /** Fills a rectangle of cells with one character. */
    fill(x: number, y: number, width: number, height: number, code: number): void {
        for (let row = 0; row < height; ++row) {
            for (let column = 0; column < width; ++column) this.data[this.at(x + column, y + row)] = code & 0xff;
        }
    }

    /** Fills every cell. 32 is a space, which is what a font puts there. */
    clear(code = 32): void {
        this.fill(0, 0, this.columns, this.rows, code);
    }

    /**
     * Copies another grid in with its top left at (x, y) - a `NameBuffer`
     * built up this frame, typically, landing on the screen whole.
     */
    transfer(source: CellGrid, x = 0, y = 0): void {
        for (let row = 0; row < source.rows; ++row) {
            for (let column = 0; column < source.columns; ++column) {
                this.data[this.at(x + column, y + row)] = source.get(column, row);
            }
        }
    }

    /**
     * Moves everything `dx` cells right and `dy` down, filling what is
     * uncovered with `code`: the character scroll of the MSX1, a cell at a
     * time. For a smooth one, move the display with R23 instead.
     */
    shift(dx: number, dy: number, code = 32): void {
        const copy = new Uint8Array(this.columns * this.rows);
        for (let y = 0; y < this.rows; ++y) for (let x = 0; x < this.columns; ++x) copy[y * this.columns + x] = this.get(x, y);
        for (let y = 0; y < this.rows; ++y) {
            for (let x = 0; x < this.columns; ++x) {
                const sx = x - dx, sy = y - dy;
                const inside = sx >= 0 && sy >= 0 && sx < this.columns && sy < this.rows;
                this.data[this.at(x, y)] = inside ? copy[sy * this.columns + sx]! : code & 0xff;
            }
        }
    }

    private at(x: number, y: number): number {
        return this.index(wrap(Math.round(x), this.columns), wrap(Math.round(y), this.rows));
    }
}

/**
 * A name table in RAM. Build the frame in one of these - clear it, draw the
 * map, the score, the enemies made of characters - and `transfer` it to the
 * screen in one go. 32x24 is the screen; 32x32 the whole table.
 */
export class NameBuffer extends CellGrid {
    protected readonly data: Uint8Array;

    constructor(readonly columns = NAME_COLUMNS, readonly rows = SCREEN_ROWS) {
        super();
        this.data = new Uint8Array(columns * rows);
    }

    /** The codes, row after row - for saving a screen, or filling one from a file. */
    get cells(): Uint8Array {
        return this.data;
    }

    protected index(x: number, y: number): number {
        return y * this.columns + x;
    }
}

// --- The tables ------------------------------------------------------------

/**
 * The pattern, colour and name tables of G1, G2 and G3, wherever the VDP has
 * them. Every call checks the mode: what a colour byte means depends on it.
 */
export class Pcg extends CellGrid {
    readonly columns = NAME_COLUMNS;
    readonly rows = NAME_ROWS;
    protected readonly data: Uint8Array;

    constructor(private readonly vdp: Vdp) {
        super();
        this.data = vdp.vram;
    }

    /** The name table the VDP is showing, which is the one `put` and the rest write. */
    get nameTable(): number {
        return this.vdp.tables.layout;
    }

    /**
     * How many banks of patterns and colours there are. 1 in G1. In G2 and G3,
     * 4 - the fourth drawing the rows a vertical scroll brings in - unless the
     * name table sits where the fourth would be, as MSX-BASIC's layout has it,
     * and then 3.
     */
    get banks(): number {
        const mode = this.require();
        if (mode === "G1") return 1;
        const { layout, patterns, colors } = this.vdp.tables;
        const fourth = (base: number) => layout >= base + 3 * BANK_SIZE && layout < base + 4 * BANK_SIZE;
        return fourth(patterns) || fourth(colors) ? 3 : 4;
    }

    /**
     * Loads a character's shape: 8 rows, bit 7 leftmost. In G2 and G3 `bank`
     * picks the third of the screen; left out, every bank gets it.
     */
    setPattern(code: number, rows: ArrayLike<number>, bank?: number): void {
        for (const b of this.banksOf(bank)) {
            const at = this.vdp.tables.patterns + b * BANK_SIZE + (code & 0xff) * 8;
            for (let y = 0; y < 8; ++y) this.data[at + y] = (rows[y] ?? 0) & 0xff;
        }
    }

    /** Loads many shapes at once: `bytes` is 8 per character, from `first` on. */
    setPatterns(first: number, bytes: ArrayLike<number>, bank?: number): void {
        const count = Math.ceil(bytes.length / 8);
        const rows = new Array<number>(8);
        for (let i = 0; i < count; ++i) {
            for (let y = 0; y < 8; ++y) rows[y] = bytes[i * 8 + y] ?? 0;
            this.setPattern(first + i, rows, bank);
        }
    }

    /**
     * Colours a character, every row alike. In G1 colour belongs to eight
     * codes together, so this colours `code & ~7` to `code | 7`.
     */
    setColor(code: number, foreground: number, background = 0, bank?: number): void {
        const pair = colorPair(foreground, background);
        if (this.require() === "G1") {
            this.data[this.vdp.tables.colors + ((code & 0xff) >> 3)] = pair;
            return;
        }
        this.setRowColors(code, [pair, pair, pair, pair, pair, pair, pair, pair], bank);
    }

    /** G2 and G3: a colour table byte for each of a character's 8 rows. G1 throws. */
    setRowColors(code: number, colors: ArrayLike<number>, bank?: number): void {
        if (this.require() === "G1") {
            throw new Error("G1 colours eight characters at a time, not a row at a time - use setColor, or G2 or G3");
        }
        for (const b of this.banksOf(bank)) {
            const at = this.vdp.tables.colors + b * BANK_SIZE + (code & 0xff) * 8;
            for (let y = 0; y < 8; ++y) this.data[at + y] = (colors[y] ?? 0) & 0xff;
        }
    }

    /**
     * A one-colour character from a bitmap (see `parsePattern`), set bits in
     * `foreground` and the rest in `background` - 0, the backdrop, unless
     * given. In G1 the colours go to the character's whole group of eight.
     */
    define(code: number, bitmap: readonly string[], foreground: number, background = 0, bank?: number): void {
        this.setPattern(code, parsePattern(bitmap), bank);
        this.setColor(code, foreground, background, bank);
    }

    /**
     * A character from a bitmap drawn in colours (see `parseMulticolor`), two
     * to a row. G1 has one pair for a group of eight characters, so there the
     * whole character may hold two, and they colour its group - unless it is
     * all colour 0, which leaves the group's colours be.
     */
    defineMulticolor(code: number, bitmap: readonly string[], options: { palette?: Readonly<Record<string, number>>; bank?: number } = {}): void {
        if (this.require() === "G1") {
            const pixels: number[] = [];
            for (let y = 0; y < 8; ++y) pixels.push(...pixelsOf(bitmap[y] ?? "", options.palette ?? {}, y));
            const [fg, bg] = pairFor(pixels, () => `character ${code} has more than two colours; G1 gives a character two, shared by its group of eight`);
            const rows: number[] = [];
            for (let y = 0; y < 8; ++y) rows.push(bitsOf(pixels.slice(y * 8, y * 8 + 8), fg, bg));
            this.setPattern(code, rows);
            if (fg !== 0 || bg !== 0) this.setColor(code, fg, bg);
            return;
        }
        let pattern: MulticolorCharacter;
        try {
            pattern = parseMulticolor(bitmap, options.palette);
        } catch (e) {
            throw new Error(`character ${code}: ${(e as Error).message}`);
        }
        this.setPattern(code, pattern.rows, options.bank);
        this.setRowColors(code, pattern.colors, options.bank);
    }

    protected index(x: number, y: number): number {
        this.require();
        return this.vdp.tables.layout + y * NAME_COLUMNS + x;
    }

    private banksOf(bank: number | undefined): number[] {
        const banks = this.banks;
        if (banks === 1) return [0];
        if (bank === undefined) return banks === 4 ? [0, 1, 2, 3] : [0, 1, 2];
        if (bank < 0 || bank >= banks) throw new Error(`bank ${bank}: there are ${banks}, 0-${banks - 1}`);
        return [bank];
    }

    private require(): PatternModeName {
        const name = this.vdp.mode.name;
        if (!isPatternMode(name)) {
            throw new Error(`${name} is not a character mode - the PCG needs G1, G2 or G3 (SCREEN 1, 2 or 4)`);
        }
        return name;
    }
}

// --- Internals -------------------------------------------------------------

function wrap(value: number, size: number): number {
    return ((value % size) + size) % size;
}

function pixelsOf(row: string, palette: Readonly<Record<string, number>>, y: number): number[] {
    const line: number[] = [];
    for (let x = 0; x < 8; ++x) {
        const char = row[x] ?? ".";
        const mapped = palette[char];
        if (mapped !== undefined) { line.push(mapped & 0x0f); continue; }
        if (char === " " || char === ".") { line.push(0); continue; }
        const hex = parseInt(char, 16);
        if (Number.isNaN(hex)) throw new Error(`pattern bitmap: "${char}" at row ${y}, column ${x} is not in the palette or a hex digit`);
        line.push(hex);
    }
    return line;
}

function pairFor(pixels: readonly number[], tooMany: () => string): [number, number] {
    const counts = new Map<number, number>();
    for (const c of pixels) counts.set(c, (counts.get(c) ?? 0) + 1);
    if (counts.size > 2) throw new Error(tooMany());
    const colors = [...counts.keys()];
    if (colors.length === 1) return [colors[0]!, 0];
    let [a, b] = colors as [number, number];
    if (a === 0 || (b !== 0 && counts.get(a)! > counts.get(b)!)) [a, b] = [b, a];
    return [a, b];
}

function bitsOf(line: readonly number[], fg: number, bg: number): number {
    let bits = 0;
    for (let x = 0; x < 8; ++x) if (line[x] === fg && fg !== bg) bits |= 0x80 >> x;
    return bits;
}
