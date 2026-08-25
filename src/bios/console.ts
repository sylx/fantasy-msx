// A character grid over the bitmap.
//
// The V9938 has real text modes - T1 and T2 are in the mode table - and this
// is not one of them. They are pattern-based, one bit deep, and they have no
// glyphs but the ones in a ROM, which is exactly the wall a Japanese text
// screen runs into: the shapes are not there. A Japanese MSX2 answered that
// with a kanji ROM and a driver that copied patterns out of it into VRAM, and
// the same answer works here with the host's fonts in the ROM's place. So the
// grid is laid over a bitmap mode, where anything can be drawn.
//
// What makes it a console rather than a loop calling `gfx.text` is the shadow
// buffer. Every cell's character and colours are kept, writes go into that,
// and `flush` repaints only the cells that actually changed. An editor can
// therefore re-emit its whole visible page every frame and cost a handful of
// cells - `repainted` says how few - which is what keeps a text screen honest
// on a machine where drawing is not free.
//
// Painting goes through `gfx.now`, not the blitter. A caret that arrives three
// frames after the key was struck is a broken caret, and LOOM makes the same
// call for the same reason: a control that has to be under the mouse this
// frame cannot wait. Scrolling is the exception worth knowing about - it moves
// the pixels with one VRAM-to-VRAM copy instead of repainting every cell.
//
// The glyphs come from a `GlyphSource`, which is the seam the next step goes
// through: the ROM font is one implementation, and a cache of host-rasterised
// glyphs living in a spare VRAM page - the kanji ROM's replacement - is the
// other. Nothing above this line knows which it is talking to.

import { CHAR_HEIGHT, CHAR_WIDTH, FONT, glyphOffset } from "./font.js";
import type { Graphics } from "./gfx.js";
import type { Raster, Rect } from "./raster.js";
import type { Screen } from "./screen.js";

/** Where a console's glyphs come from, and how big a cell has to be to hold one. */
export interface GlyphSource {
    readonly cellWidth: number;
    readonly cellHeight: number;
    /**
     * Cells the character occupies. One for everything a Latin font has, two
     * for the kana and kanji, which is the geometry a Japanese text screen is
     * built on rather than a detail of how they are drawn.
     */
    cells(code: number): number;
    /**
     * Draws one character, background and all, into the cells it occupies.
     * `code` is a code point; a source with no glyph for it draws whatever it
     * uses for the ones it has not got.
     */
    draw(raster: Raster, x: number, y: number, code: number, foreground: number, background: number): void;
}

/** The machine's own 6x8 font, which is ASCII 32 to 126 and nothing else. */
export function romFont(): GlyphSource {
    return {
        cellWidth: CHAR_WIDTH,
        cellHeight: CHAR_HEIGHT,
        cells: () => 1,
        draw(raster, x, y, code, foreground, background) {
            raster.fillRect(x, y, CHAR_WIDTH, CHAR_HEIGHT, background);
            if (code === 32) return;                    // a space is the background
            const glyph = glyphOffset(code);
            for (let row = 0; row < CHAR_HEIGHT; ++row) {
                let bits = FONT[glyph + row];
                for (let column = 0; bits; ++column, bits = (bits << 1) & 0xff) {
                    if (bits & 0x80) raster.pixel(x + column, y + row, foreground);
                }
            }
        }
    };
}

const SPACE = 32;
/**
 * What sits in the right-hand cell of a double-width character. Not a code
 * point: it is the mark that says "the character here begins one cell left",
 * and it is what keeps the caret from landing inside a kanji.
 */
const TRAIL = 0;
/** Columns a tab advances to the next multiple of. */
const TAB = 8;

export class Console {
    private font: GlyphSource;
    /** Code point per cell. */
    private chars = new Uint32Array(0);
    /** Foreground in the low nibble, background in the high one. */
    private attrs = new Uint8Array(0);
    /** Cells whose pixels no longer match the two arrays above. */
    private stale = new Uint8Array(0);

    private columns = 0;
    private lines = 0;
    /** Top left of the grid in screen pixels: the remainder, split either side. */
    private originX = 0;
    private originY = 0;
    /** The geometry the grid was last fitted to, so a mode change is noticed. */
    private fittedTo = "";

    private column = 0;
    private line = 0;
    private attr = 0x0f;
    /** Where the cursor is currently painted, so it can be lifted before it moves. */
    private cursorCell: number | null = null;
    /** Cells ever painted, the reading at the end of the last flush, and the difference. */
    private strokes = 0;
    private baseline = 0;
    private painted = 0;

    /**
     * Whether the cursor is drawn this flush. There is no clock in here - an
     * app blinks it from its own frame count, which is also how it stops it
     * blinking while a key is being held down.
     */
    cursorOn = false;

    constructor(private readonly gfx: Graphics, private readonly screen: Screen, font: GlyphSource = romFont()) {
        this.font = font;
        this.fit();
    }

    // --- Geometry ---------------------------------------------------------

    get cols(): number {
        return this.columns;
    }

    get rows(): number {
        return this.lines;
    }

    get cellWidth(): number {
        return this.font.cellWidth;
    }

    get cellHeight(): number {
        return this.font.cellHeight;
    }

    /**
     * Cells painted since the previous flush finished, which includes anything
     * a `scroll` in between had to lay down. An idle screen costs none.
     */
    get repainted(): number {
        return this.painted;
    }

    get cursor(): { readonly col: number; readonly row: number } {
        return { col: this.column, row: this.line };
    }

    /**
     * Where a cell sits on the screen. The grid is centred in whatever the
     * cell size does not divide, so this is also the only honest way for
     * anything drawn with `gfx` to line up with the characters.
     */
    cellRect(col: number, row: number): Rect {
        return {
            x: this.originX + col * this.font.cellWidth,
            y: this.originY + row * this.font.cellHeight,
            width: this.font.cellWidth,
            height: this.font.cellHeight
        };
    }

    /** Swaps the glyphs, and with them the cell size. Everything is redrawn. */
    setFont(font: GlyphSource): void {
        this.font = font;
        this.fit();
    }

    /**
     * Sizes the grid to the screen. Called for you when the mode has changed
     * under it, which is why an app can `setMode` and go on writing - what it
     * cannot do is expect the characters to survive, since the mode change
     * took the framebuffer with it.
     */
    fit(): void {
        const cellWidth = this.font.cellWidth;
        const cellHeight = this.font.cellHeight;
        this.columns = Math.floor(this.screen.width / cellWidth);
        this.lines = Math.floor(this.screen.height / cellHeight);
        this.originX = (this.screen.width - this.columns * cellWidth) >> 1;
        this.originY = (this.screen.height - this.lines * cellHeight) >> 1;
        this.fittedTo = this.geometry();

        const cells = this.columns * this.lines;
        this.chars = new Uint32Array(cells).fill(SPACE);
        this.attrs = new Uint8Array(cells).fill(this.attr);
        this.stale = new Uint8Array(cells).fill(1);
        this.cursorCell = null;
        this.column = 0;
        this.line = 0;
    }

    // --- Writing ----------------------------------------------------------

    /** The colours everything written from here on takes. */
    color(foreground: number, background = this.attr >> 4): void {
        this.attr = (foreground & 0x0f) | ((background & 0x0f) << 4);
    }

    locate(col: number, row: number): void {
        this.column = clamp(col, 0, this.columns - 1);
        this.line = clamp(row, 0, this.lines - 1);
        // The caret belongs on a character, never inside one.
        if (this.chars[this.line * this.columns + this.column] === TRAIL) --this.column;
    }

    /** Blanks the grid in the current colours and sends the cursor home. */
    cls(): void {
        this.chars.fill(SPACE);
        this.attrs.fill(this.attr);
        this.stale.fill(1);
        this.column = 0;
        this.line = 0;
    }

    /** One character, at a place of your choosing, leaving the cursor alone. */
    put(col: number, row: number, character: string, foreground?: number, background?: number): void {
        if (col < 0 || row < 0 || col >= this.columns || row >= this.lines) return;
        this.place(row * this.columns + col, character.codePointAt(0) ?? SPACE, this.attrOf(foreground, background));
    }

    /**
     * A string at a place of your choosing: no wrapping, no scrolling, and the
     * cursor stays where it was. This is what a status bar or a rendered line
     * of a document wants - pad it to the width you mean to occupy and the
     * cells that did not change go unpainted.
     */
    text(col: number, row: number, text: string, foreground?: number, background?: number): void {
        if (row < 0 || row >= this.lines) return;
        const attr = this.attrOf(foreground, background);
        let x = col;
        for (const character of text) {
            const code = character.codePointAt(0) ?? SPACE;
            const width = this.font.cells(code);
            if (x + width > this.columns) return;
            if (x >= 0) this.place(row * this.columns + x, code, attr);
            x += width;
        }
    }

    /**
     * Writes at the cursor and moves it on, wrapping at the right edge and
     * scrolling at the bottom. Understands newline, carriage return and tab.
     * This is the streaming half of the console; `text` is the addressed one.
     */
    write(text: string): void {
        for (const character of text) {
            if (character === "\n") { this.newline(); continue; }
            if (character === "\r") { this.column = 0; continue; }
            if (character === "\t") {
                const stop = Math.min(this.columns, (Math.floor(this.column / TAB) + 1) * TAB);
                while (this.column < stop) this.advance(SPACE);
                continue;
            }
            this.advance(character.codePointAt(0) ?? SPACE);
        }
    }

    writeln(text = ""): void {
        this.write(text);
        this.newline();
    }

    /** Blanks a rectangle of cells. */
    fill(col: number, row: number, width: number, height: number, foreground?: number, background?: number): void {
        const attr = this.attrOf(foreground, background);
        for (let y = Math.max(0, row); y < Math.min(this.lines, row + height); ++y) {
            for (let x = Math.max(0, col); x < Math.min(this.columns, col + width); ++x) {
                this.place(y * this.columns + x, SPACE, attr);
            }
        }
    }

    /**
     * Moves rows up by `lines`, or down when it is negative, and blanks what
     * that exposes. `fromRow` and `rowCount` confine it to a band, which is
     * what an editor with bars above and below its text needs.
     *
     * The pixels are moved rather than repainted: one VRAM-to-VRAM copy of the
     * band, which on a real V9938 is the cheapest thing the chip does and is
     * why text screens scrolled as fast as they did. All that is left needing
     * paint is the row the copy uncovered.
     */
    scroll(lines = 1, fromRow = 0, rowCount = this.lines - fromRow): void {
        const first = clamp(fromRow, 0, this.lines);
        const count = Math.min(rowCount, this.lines - first);
        if (lines === 0 || count <= 0) return;
        if (Math.abs(lines) >= count) {
            this.fill(0, first, this.columns, count);
            return;
        }

        // The screen has to already agree with the shadow buffer, or stale
        // pixels get carried along and marked as good.
        this.lift();
        this.paintStale();

        const start = first * this.columns;
        const end = (first + count) * this.columns;
        const move = lines * this.columns;

        if (lines > 0) {
            this.chars.copyWithin(start, start + move, end);
            this.attrs.copyWithin(start, start + move, end);
            this.chars.fill(SPACE, end - move, end);
            this.attrs.fill(this.attr, end - move, end);
            this.stale.fill(0, start, end - move);
            this.stale.fill(1, end - move, end);
        } else {
            this.chars.copyWithin(start - move, start, end + move);
            this.attrs.copyWithin(start - move, start, end + move);
            this.chars.fill(SPACE, start, start - move);
            this.attrs.fill(this.attr, start, start - move);
            this.stale.fill(0, start - move, end);
            this.stale.fill(1, start, start - move);
        }

        const cellHeight = this.font.cellHeight;
        const width = this.columns * this.font.cellWidth;
        const top = this.originY + first * cellHeight;
        const height = (count - Math.abs(lines)) * cellHeight;
        if (lines > 0) this.gfx.now.blit(this.originX, top + lines * cellHeight, this.originX, top, width, height);
        else this.gfx.now.blit(this.originX, top, this.originX, top - lines * cellHeight, width, height);
    }

    // --- Reading ----------------------------------------------------------

    /** A row as a string, which is what a test wants to look at. */
    rowText(row: number): string {
        if (row < 0 || row >= this.lines) return "";
        let out = "";
        for (let x = 0; x < this.columns; ++x) {
            const code = this.chars[row * this.columns + x];
            // A trail cell has no character of its own - the one to its left
            // is already two cells wide.
            if (code !== TRAIL) out += String.fromCodePoint(code);
        }
        return out;
    }

    // --- Painting ---------------------------------------------------------

    /**
     * Puts the changed cells on the screen. Cheap by construction: cells whose
     * character and colours did not change are not touched, so re-emitting a
     * whole page every frame costs only what moved. A screen nobody is typing
     * into costs nothing, and a blinking caret one cell a phase.
     */
    flush(): void {
        if (this.geometry() !== this.fittedTo) this.fit();

        const cell = this.cursorOn ? this.line * this.columns + this.column : null;

        // The cursor is lifted only when it is going somewhere else, or when
        // the cell it is sitting on has been written to underneath it.
        if (this.cursorCell !== null && (this.cursorCell !== cell || this.stale[this.cursorCell] !== 0)) {
            this.lift();
        }
        this.paintStale();

        if (cell !== null && this.cursorCell === null) {
            this.paintCell(this.gfx.now, cell, true);
            this.cursorCell = cell;
        }
        this.painted = this.strokes - this.baseline;
        this.baseline = this.strokes;
    }

    // --- Internals --------------------------------------------------------

    private geometry(): string {
        return `${this.screen.width}x${this.screen.height}:${this.font.cellWidth}x${this.font.cellHeight}`;
    }

    private attrOf(foreground?: number, background?: number): number {
        if (foreground === undefined && background === undefined) return this.attr;
        const fg = foreground ?? (this.attr & 0x0f);
        const bg = background ?? (this.attr >> 4);
        return (fg & 0x0f) | ((bg & 0x0f) << 4);
    }

    /** Writes one cell of the shadow buffer, marking it only if it really changed. */
    private set(cell: number, code: number, attr: number): void {
        if (this.chars[cell] === code && this.attrs[cell] === attr) return;
        this.chars[cell] = code;
        this.attrs[cell] = attr;
        this.stale[cell] = 1;
    }

    /**
     * Writes a character into the cells it takes, and clears whatever it lands
     * on the wrong half of. Overwriting one cell of a kanji leaves the other
     * half stranded, so the stranded half becomes a space rather than a
     * fragment of a character that is no longer there.
     */
    private place(cell: number, code: number, attr: number): void {
        const width = this.font.cells(code);
        if (width === 2 && (cell % this.columns) === this.columns - 1) {
            // No room for the second half; a space is the honest answer.
            return this.place(cell, SPACE, attr);
        }

        for (let i = 0; i < width; ++i) this.strand(cell + i);
        this.set(cell, code, attr);
        if (width === 2) this.set(cell + 1, TRAIL, attr);
    }

    /** Turns whatever half-covers `cell` into spaces, so no fragment survives. */
    private strand(cell: number): void {
        if (this.chars[cell] === TRAIL) this.set(cell - 1, SPACE, this.attrs[cell - 1]);
        else if (this.font.cells(this.chars[cell]) === 2) this.set(cell + 1, SPACE, this.attrs[cell + 1]);
    }

    private advance(code: number): void {
        const width = this.font.cells(code);
        // A character that will not fit in what is left of the line goes on the
        // next one whole, rather than being split across the wrap.
        if (this.column + width > this.columns) this.newline();
        this.place(this.line * this.columns + this.column, code, this.attr);
        this.column += width;
        if (this.column >= this.columns) this.newline();
    }

    private newline(): void {
        this.column = 0;
        if (++this.line < this.lines) return;
        this.line = this.lines - 1;
        this.scroll(1);
    }

    /** Takes the drawn cursor off the screen, so the cell under it can be seen again. */
    private lift(): void {
        if (this.cursorCell === null) return;
        this.stale[this.cursorCell] = 1;
        this.cursorCell = null;
    }

    private paintStale(): void {
        const raster = this.gfx.now;
        for (let cell = 0; cell < this.stale.length; ++cell) {
            if (this.stale[cell] === 0) continue;
            // A trail cell is painted by the character to its left, never on
            // its own - half a kanji is not a thing that can be drawn.
            this.paintCell(raster, this.chars[cell] === TRAIL ? cell - 1 : cell, false);
        }
    }

    private paintCell(raster: Raster, cell: number, invert: boolean): void {
        ++this.strokes;
        const code = this.chars[cell];
        const wide = this.font.cells(code);
        const width = this.font.cellWidth;
        const height = this.font.cellHeight;
        const x = this.originX + (cell % this.columns) * width;
        const y = this.originY + Math.floor(cell / this.columns) * height;

        const attr = this.attrs[cell];
        const foreground = invert ? attr >> 4 : attr & 0x0f;
        const background = invert ? attr & 0x0f : attr >> 4;

        this.font.draw(raster, x, y, code, foreground, background);
        // Both halves are now on the screen, whichever of them was owed paint.
        for (let i = 0; i < wide; ++i) this.stale[cell + i] = 0;
    }
}

function clamp(value: number, low: number, high: number): number {
    return value < low ? low : value > high ? high : value;
}
