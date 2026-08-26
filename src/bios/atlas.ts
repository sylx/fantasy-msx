// The font cache, in VRAM.
//
// A Japanese MSX2 had a kanji ROM: a few thousand 16x16 bitmaps the machine
// could not draw and did not have to, because a driver copied the ones it
// needed out of the ROM and into VRAM, and the screen was then built out of
// VRAM-to-VRAM copies. This is the same arrangement with the ROM replaced by
// the host's own typefaces - which is the bargain `text.ts` already strikes for
// display type, applied to a character grid.
//
// So there are two caches and they are not the same. The browser's rasteriser
// is asked for a glyph once, ever; the result lands in a page of VRAM and every
// appearance of that character after it is a copy inside video memory. What
// makes that worth doing here is not speed - the console paints immediately, so
// nothing is being paced - it is that **the budget becomes real**. A page holds
// 512 half-width slots. A screen of Japanese is a few hundred distinct
// characters. Run past it and something has to go, and `evictions` says how
// often that is happening, which is a number an MSX programmer would have
// recognised.
//
// ## Levels, not colours
//
// The obvious way to store a glyph is in the colours it will be drawn in, and
// it is the wrong way: the same character in the status bar and in the body
// would be two entries, and the 512 would go four times as fast. So the atlas
// stores **coverage levels** - 0 for the paper and 1..n for the ink - and the
// colour is applied on the way out, by a 256-entry table that maps a whole byte
// of packed pixels at once. One entry per character, any colours, and the copy
// stays byte-at-a-time.
//
// That table is also where antialiasing lives. `ramp` is handed the cell's
// foreground and returns the indices the levels take; one entry is a hard edge,
// three is a stroke with a flank. As everywhere else here, the palette is an
// input - the atlas never picks a colour or repaints a register.

import type { Vdp } from "../api/index.js";
import type { GlyphSource } from "./console.js";
import type { Raster } from "./raster.js";
import type { Screen } from "./screen.js";
import type { TextStyle, Typesetter } from "./text.js";
import { charCells } from "./width.js";

/** The size a kanji ROM used, and what a cell defaults to. */
const ROM_CELL_HEIGHT = 16;

export interface AtlasOptions {
    /**
     * The VRAM page the glyphs live in. It must not be a page anything is drawn
     * on: SCREEN 5 has four and a double-buffered app is using two, SCREEN 7
     * has two and an app that does not flip has one to spare. Default 1.
     */
    page?: number;
    /**
     * Cell height in pixels. Default 16, which is what a kanji ROM's glyphs
     * were. The width follows: a half-width cell is half as wide as it is
     * tall, and in the 512-wide modes that is twice as many pixels for the
     * same shape - the trade `text.ts` makes with `stretch`.
     */
    cellHeight?: number;
    /**
     * Cell width in pixels, when the default will not do. A bitmap face has a
     * grid of its own and it is rarely half its height: JF Dot K12x10 is twelve
     * dots across an em ten tall, so its half-width cell is 6x10 and nothing
     * derived from the height would find that.
     */
    cellWidth?: number;
    /**
     * Whether to scale the em until the glyphs fill the cell. On by default,
     * because an outline face has no size of its own and something has to pick
     * one. **Turn it off for a bitmap face**: those are drawn for exactly one
     * size, `style.size` is that size, and a scaled bitmap is a blurred one.
     */
    fit?: boolean;
    /** How the glyphs are set. A monospaced family is worth choosing here. */
    style?: TextStyle;
    /** Ink levels stored per pixel: 1 for a hard edge, up to 3 for a flank. Default 1. */
    levels?: number;
    /**
     * The indices the levels are drawn in, given the cell's own foreground.
     * The default spends every level on the foreground, which with `levels: 1`
     * is exactly a threshold. Return a ramp as long as `levels` to have the
     * flank land on entries of your choosing - `(ink) => [8, 7, ink]`.
     */
    ramp?: (foreground: number) => readonly number[];
}

/** What the atlas is holding, for a readout. */
export interface AtlasStats {
    readonly slots: number;
    readonly used: number;
    readonly glyphs: number;
    readonly misses: number;
    readonly evictions: number;
    /** The em the glyphs were actually cut at, which the cell decided. */
    readonly size: number;
}

interface Slot {
    /** Index of the first slot, and how many the glyph took (1 or 2). */
    readonly at: number;
    readonly cells: number;
}

export class VramAtlas implements GlyphSource {
    private readonly vram: Uint8Array;
    private readonly width: number;
    private readonly height: number;
    private readonly levels: number;
    private readonly ramp: (foreground: number) => readonly number[];
    private readonly style: TextStyle;

    /** Where the page starts, and how the mode packs pixels into it. */
    private base = 0;
    private stride = 0;
    private pack = 1;
    /** Slots across the page and down it. */
    private across = 0;
    private down = 0;
    /** Rows from the top of a cell to the baseline the glyphs sit on. */
    private baseline = 0;
    /** The em the glyphs are actually cut at, which the cell decides. */
    private size = 0;

    /** Code point to slot, in least-recently-used order: the oldest is first. */
    private readonly slots = new Map<number, Slot>();
    /** Which slots are taken, so a two-cell glyph can find a pair. */
    private taken: Uint8Array = new Uint8Array(0);
    private cursor = 0;
    private misses = 0;
    private evictions = 0;
    /** One byte-to-byte translation per foreground and background pair. */
    private readonly tables = new Map<number, Uint8Array>();
    /** The geometry the page was last laid out for, so a mode change is noticed. */
    private laidOutFor = "";

    constructor(
        private readonly vdp: Vdp,
        private readonly screen: Screen,
        private readonly text: Typesetter,
        private readonly options: AtlasOptions = {}
    ) {
        this.vram = vdp.vram;
        this.height = options.cellHeight ?? ROM_CELL_HEIGHT;
        this.levels = Math.max(1, Math.min(3, options.levels ?? 1));
        this.ramp = options.ramp ?? ((foreground) => [foreground]);
        this.style = options.style ?? {};
        // A half-width cell keeps its shape rather than its pixel count: half
        // as wide as it is tall, and the 512-wide modes have pixels half as
        // wide, so it takes twice as many of them to stay that shape. A face
        // with a grid of its own overrides that.
        this.width = options.cellWidth ?? Math.round(this.height / 2 / screen.pixelAspect);
        this.layOut();
    }

    // --- What the console asks -------------------------------------------

    get cellWidth(): number {
        return this.width;
    }

    get cellHeight(): number {
        return this.height;
    }

    cells(code: number): number {
        return charCells(code);
    }

    /**
     * Draws a character, background and all, from the page it is cached in -
     * baking it first if this is the first time it has been asked for.
     *
     * The copy goes straight at VRAM rather than through the rasteriser's
     * per-pixel path, because a cell lands on a byte boundary and a whole byte
     * of packed pixels can be recoloured with one table lookup. It is the same
     * move `HMMM` makes on the chip, and the reason a text screen was cheap.
     */
    draw(raster: Raster, x: number, y: number, code: number, foreground: number, background: number): void {
        const slot = this.acquire(code);
        const wide = slot ? slot.cells : this.cells(code);
        const table = this.table(foreground, background);

        if (!slot) {
            // Nothing to copy from - the page is too small to hold even this
            // one glyph. Leave the cell blank rather than leaving it stale.
            raster.fillRect(x, y, this.width * wide, this.height, background);
            return;
        }

        const bytes = (this.width * wide) / this.pack;
        const source = this.address(slot.at);
        const target = raster.base + y * this.stride + x / this.pack;

        if (!Number.isInteger(bytes) || !Number.isInteger(x / this.pack)) {
            // A grid that does not land on byte boundaries cannot be copied a
            // byte at a time. Nothing here produces one, but a mode with an odd
            // packing would, and a wrong picture is worse than a slow one.
            return this.drawByPixel(raster, x, y, slot, wide, foreground, background);
        }

        for (let row = 0; row < this.height; ++row) {
            let from = source + row * this.stride;
            let to = target + row * this.stride;
            for (let i = 0; i < bytes; ++i) this.vram[to++] = table[this.vram[from++]];
        }
    }

    // --- The cache --------------------------------------------------------

    /** Bakes every character of `text` that is not already in the page. */
    preload(text: string): void {
        for (const character of text) this.acquire(character.codePointAt(0) ?? 32);
    }

    /** Drops every glyph. A change of face or size needs this; `setStyle` does it. */
    forget(): void {
        this.slots.clear();
        this.taken.fill(0);
        this.cursor = 0;
        this.tables.clear();
    }

    /** Sets the face the glyphs are cut in, and throws away the ones already cut. */
    setStyle(style: TextStyle): void {
        Object.assign(this.style, style);
        this.baseline = 0;
        this.size = 0;
        this.forget();
    }

    get stats(): AtlasStats {
        let used = 0;
        for (const flag of this.taken) used += flag;
        return {
            slots: this.taken.length,
            used,
            glyphs: this.slots.size,
            misses: this.misses,
            evictions: this.evictions,
            size: this.size
        };
    }

    /** Where a slot sits in the page, for a demo that wants to show the cache. */
    slotRect(index: number): { x: number; y: number; width: number; height: number } {
        return {
            x: (index % this.across) * this.width,
            y: Math.floor(index / this.across) * this.height,
            width: this.width,
            height: this.height
        };
    }

    /** The page the glyphs are kept in, so an app can put it on screen. */
    get page(): number {
        return this.options.page ?? 1;
    }

    // --- Internals --------------------------------------------------------

    /** Recomputes the page geometry. Cheap, and called before anything touches it. */
    private layOut(): void {
        const mode = this.screen.mode;
        const signature = `${mode.name}:${this.page}:${this.width}x${this.height}`;
        if (signature === this.laidOutFor) return;

        this.base = this.screen.pageBase(this.page);
        this.stride = mode.bytesPerLine;
        this.pack = mode.pixelsPerByte || 1;
        // The whole page, not just the part a display would show: a page is
        // taller than the 212 lines on screen and the spare rows hold glyphs.
        const lines = Math.floor((mode.pageSize || 0x8000) / this.stride);
        this.across = Math.floor(mode.width / this.width);
        this.down = Math.floor(lines / this.height);

        this.laidOutFor = signature;
        this.taken = new Uint8Array(this.across * this.down);
        this.slots.clear();
        this.cursor = 0;
        this.tables.clear();
    }

    private address(slot: number): number {
        const rect = this.slotRect(slot);
        return this.base + rect.y * this.stride + rect.x / this.pack;
    }

    /** Finds a character in the page, baking it if it is not there yet. */
    private acquire(code: number): Slot | null {
        this.layOut();

        const hit = this.slots.get(code);
        if (hit) {
            // Touch it: what is on screen every frame must not be what goes.
            this.slots.delete(code);
            this.slots.set(code, hit);
            return hit;
        }

        ++this.misses;
        const cells = this.cells(code);
        const at = this.allocate(cells);
        if (at < 0) return null;

        const slot: Slot = { at, cells };
        this.bake(code, slot);
        this.slots.set(code, slot);
        return slot;
    }

    /**
     * Finds `cells` adjacent free slots, evicting the least recently used
     * glyphs until there are some. A pair may not straddle the end of a row,
     * since a two-cell glyph is stored as one wide bitmap.
     */
    private allocate(cells: number): number {
        const total = this.taken.length;
        if (total < cells) return -1;

        for (let attempt = 0; attempt < total * 2; ++attempt) {
            const at = this.cursor;
            this.cursor = (this.cursor + 1) % total;

            if (cells === 2 && (at % this.across) === this.across - 1) continue;
            if (at + cells > total) continue;

            let free = true;
            for (let i = 0; i < cells; ++i) if (this.taken[at + i]) free = false;
            if (free) {
                for (let i = 0; i < cells; ++i) this.taken[at + i] = 1;
                return at;
            }
        }

        // Nothing free anywhere: give up the oldest glyph and look again.
        const oldest = this.slots.keys().next();
        if (oldest.done) return -1;
        this.release(oldest.value);
        ++this.evictions;
        return this.allocate(cells);
    }

    private release(code: number): void {
        const slot = this.slots.get(code);
        if (!slot) return;
        for (let i = 0; i < slot.cells; ++i) this.taken[slot.at + i] = 0;
        this.slots.delete(code);
    }

    /**
     * Rasterises one character and packs it into its slot.
     *
     * The glyph is asked for on a ramp of 1..levels against a background of 0,
     * so what comes back is already the levels this page stores. It is placed
     * on a common baseline rather than centred, or the line would ripple.
     */
    private bake(code: number, slot: Slot): void {
        const character = String.fromCodePoint(code);
        const ink: number[] = [];
        for (let i = 1; i <= this.levels; ++i) ink.push(i);

        if (this.size === 0) this.fitToCell();
        const image = this.text.render(character, { ...this.style, size: this.size, shades: ink, background: 0 });

        const cellWidth = this.width * slot.cells;
        const rect = this.slotRect(slot.at);
        const top = this.baseline - image.baseline;
        // Centred, so a glyph the face draws wider than the grid loses a little
        // from each side rather than a chunk from one. A monospaced face never
        // reaches that; a proportional one does, and looks it.
        const left = (cellWidth - image.width) >> 1;

        for (let y = 0; y < this.height; ++y) {
            let address = this.base + (rect.y + y) * this.stride + rect.x / this.pack;
            const row = y - top;

            for (let x = 0; x < cellWidth; x += this.pack) {
                let byte = 0;
                const bits = 8 / this.pack;
                for (let i = 0; i < this.pack; ++i) {
                    const column = x + i - left;
                    const level = row >= 0 && row < image.height && column >= 0 && column < image.width
                        ? image.pixels[row * image.width + column]
                        : 0;
                    // The leftmost pixel of a byte lives in its highest bits.
                    byte |= (level & ((1 << bits) - 1)) << ((this.pack - 1 - i) * bits);
                }
                this.vram[address++] = byte;
            }
        }
    }

    /**
     * Picks the em the glyphs are cut at, and where the baseline sits.
     *
     * A cell is a fixed box and a face does not care. Worse, a CJK face's
     * declared ascent and descent come to nearly one and a half times its em -
     * they cover the whole design space, not the ink - so fitting a cell to
     * those numbers leaves a 16-pixel cell holding ten pixels of type with air
     * all round it. What has to fit is the **ink**, so the ink is what is
     * measured: a glyph that fills its em square is rasterised, its covered
     * pixels are found, and the em is scaled until they fill the cell.
     *
     * Half-width glyphs are not part of the fit. A proportional face draws its
     * Latin wider than half an em and nothing but a smaller em would make it
     * fit, which would shrink the kanji to suit the alphabet. A character grid
     * wants a monospaced face; this one merely survives a proportional one.
     */
    private fitToCell(): void {
        const asked = this.style.size ?? this.height;
        let size = asked;
        let ink = this.inkOf(size);

        // A bitmap face is drawn for one size and scaling it is what ruins it,
        // so the search is skipped entirely and only the baseline is measured.
        if (this.options.fit === false) {
            this.size = asked;
            this.place(ink);
            return;
        }

        // Three passes: a face whose ink is nothing like its em needs one, and
        // the rounding of the second rarely moves enough to need a third.
        // A pixel is kept back on each axis so that lines of type do not touch:
        // the probe is the fullest glyph a face has, and if it fills the cell
        // exactly then a screen of it is a solid block.
        const room = { width: this.width * 2 - 1, height: this.height - 1 };

        for (let attempt = 0; attempt < 3 && ink; ++attempt) {
            const scale = Math.min(room.width / ink.width, room.height / ink.height);
            if (Math.abs(scale - 1) < 0.02) break;
            const next = Math.max(4, Math.min(this.height * 2, Math.round(size * scale)));
            if (next === size) break;
            size = next;
            ink = this.inkOf(size);
        }

        this.size = size;
        this.place(ink);
    }

    /**
     * Where the baseline goes, once the size is settled. The ink sits in the
     * middle of the cell rather than on a typographic baseline: in a grid this
     * size the difference is a pixel and the evenness is worth more than the
     * tradition.
     */
    private place(ink: { height: number; top: number; baseline: number } | null): void {
        if (ink) {
            this.baseline = ink.baseline + Math.round((this.height - ink.height) / 2) - ink.top;
        } else {
            const box = this.text.measure("Ay", { ...this.style, size: this.size });
            this.baseline = Math.min(box.baseline, this.height - 1);
        }
        if (!(this.baseline > 0)) this.baseline = Math.round(this.height * 0.8);
    }

    /**
     * The covered part of a glyph that fills its em square, at a given size.
     * U+56FD is a kanji whose strokes reach every edge of the em, which makes
     * it the closest thing a face has to a ruler. Null when the face draws
     * nothing for it, which is a face with no kanji in it.
     */
    private inkOf(size: number): { width: number; height: number; top: number; baseline: number } | null {
        const image = this.text.render("\u56fd", { ...this.style, size, shades: [1], background: 0 });

        let left = image.width;
        let right = -1;
        let top = image.height;
        let bottom = -1;
        for (let y = 0; y < image.height; ++y) {
            for (let x = 0; x < image.width; ++x) {
                if (image.pixels[y * image.width + x] === 0) continue;
                if (x < left) left = x;
                if (x > right) right = x;
                if (y < top) top = y;
                if (y > bottom) bottom = y;
            }
        }
        if (right < 0) return null;
        return { width: right - left + 1, height: bottom - top + 1, top, baseline: image.baseline };
    }

    /**
     * A byte of packed levels to a byte of packed palette indices. Built once
     * per pair of colours - a console uses a handful - and thrown away when the
     * page is.
     */
    private table(foreground: number, background: number): Uint8Array {
        const key = (foreground & 0x0f) << 4 | (background & 0x0f);
        const found = this.tables.get(key);
        if (found) return found;

        const ramp = this.ramp(foreground);
        const bits = 8 / this.pack;
        const mask = (1 << bits) - 1;
        const table = new Uint8Array(256);

        for (let byte = 0; byte < 256; ++byte) {
            let out = 0;
            for (let i = 0; i < this.pack; ++i) {
                const shift = (this.pack - 1 - i) * bits;
                const level = (byte >> shift) & mask;
                const colour = level === 0 ? background : ramp[Math.min(level, ramp.length) - 1];
                out |= (colour & mask) << shift;
            }
            table[byte] = out;
        }

        this.tables.set(key, table);
        return table;
    }

    /** The slow way, for a grid that does not land on byte boundaries. */
    private drawByPixel(raster: Raster, x: number, y: number, slot: Slot, wide: number, foreground: number, background: number): void {
        const ramp = this.ramp(foreground);
        const rect = this.slotRect(slot.at);
        const bits = 8 / this.pack;
        const mask = (1 << bits) - 1;

        for (let row = 0; row < this.height; ++row) {
            const source = this.base + (rect.y + row) * this.stride + rect.x / this.pack;
            for (let column = 0; column < this.width * wide; ++column) {
                const byte = this.vram[source + ((column / this.pack) | 0)];
                const level = (byte >> ((this.pack - 1 - (column % this.pack)) * bits)) & mask;
                raster.pixel(x + column, y + row, level === 0 ? background : ramp[Math.min(level, ramp.length) - 1]);
            }
        }
    }
}
