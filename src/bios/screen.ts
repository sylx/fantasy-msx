// Display setup: mode, pages, palette and scrolling.
//
// SCREEN 5 gives 128KB of VRAM as four 32KB pages, of which a 256x212 image
// uses 0x6A00. The spare 0x1600 at the top of page 0 holds the sprite tables,
// which stay put while the framebuffer pages flip beneath them.
//
// The pattern modes - SCREEN 1, 2 and 4 - have no framebuffer at all. A
// "page" there is a name table: 1KB of character codes, 32 across and 32 down,
// which is the 256 lines R23 scrolls round. Flipping one is still a write to
// R2, so double buffering and scroll bands work on them unchanged.

import { type PaletteColor, type ScreenModeName, type Vdp } from "../api/index.js";
import type { FantasyMachine } from "../core/machine.js";
import { Scroll } from "./scroll.js";

/**
 * Where the sprite tables sit inside page 0, measured back from the end of it.
 * A 256x212 image never fills a page - SCREEN 5 uses 0x6A00 of 0x8000, SCREEN 7
 * 0xD400 of 0x10000 - and this is the gap that leaves.
 */
const SPRITE_TABLE_OFFSET = 0x0c00;

/** The modes built from 8x8 characters: SCREEN 1, 2 and 4. */
export type PatternModeName = "G1" | "G2" | "G3";

export function isPatternMode(name: ScreenModeName): name is PatternModeName {
    return name === "G1" || name === "G2" || name === "G3";
}

/**
 * Where the pattern modes keep their tables. Not MSX-BASIC's layout, which
 * packs SCREEN 2 into 16KB and leaves no room for a name table 32 rows deep,
 * let alone several.
 */
export const PATTERN_TABLES = {
    /** 256 characters x 8 bytes in SCREEN 1; four banks of them in SCREEN 2 and 4. */
    patterns: 0x0000,
    /** One byte per eight characters in SCREEN 1; one per character row in SCREEN 2 and 4. */
    colors: 0x2000,
    /**
     * The first name table. The next few follow it 1KB apart, alternating with
     * copies 32KB further up: the V9958's two-page horizontal scroll pairs a
     * name table with the one A15 away, so page 2n+1 sits 0x8000 above 2n.
     */
    names: 0x4000,
    /** How many name tables there are to flip between. */
    pages: 8
} as const;

export interface SpriteTables {
    /** In sprite mode 2 this holds the per-line colours; attributes follow it. */
    readonly colors: number;
    readonly attributes: number;
    readonly patterns: number;
}

export class Screen {
    private display = 0;
    private draw = 0;
    private tables: SpriteTables = spriteTablesFor(0x8000);

    /** Where the display looks into the plane, and the bands that split it. */
    readonly scroll: Scroll;

    constructor(private readonly vdp: Vdp, private readonly machine: FantasyMachine) {
        this.scroll = new Scroll(vdp, this);
    }

    /**
     * Where the sprite tables live. They stay put in page 0 while the
     * framebuffer pages flip beneath them, but they do move when the mode
     * changes - a SCREEN 7 page is twice as long as a SCREEN 5 one.
     */
    get spriteTables(): SpriteTables {
        return this.tables;
    }

    /**
     * Sets up a screen. Geometry reaches the raster at the next vertical sync,
     * so the frame you call this in still renders with the old borders.
     *
     * G1, G2 and G3 get their tables where `tiles` expects them (see
     * `PATTERN_TABLES`). VRAM is left as it was, so whatever the last mode put
     * there shows as characters until `tiles` is given something to draw.
     */
    setMode(name: ScreenModeName = "G4"): void {
        this.vdp.setMode(name, 0);
        this.tables = spriteTablesFor(this.vdp.mode.pageSize || 0x8000);
        const pattern = isPatternMode(name);
        this.vdp.setTables({
            layout: pattern ? PATTERN_TABLES.names : 0,
            colors: pattern ? PATTERN_TABLES.colors : 0,
            patterns: pattern ? PATTERN_TABLES.patterns : 0,
            // Sprite mode 2 points R5 at the colours, with the attributes 512
            // bytes later; sprite mode 1 has no colour table and points at them.
            spriteAttributes: this.spriteMode === 2 ? this.tables.colors : this.tables.attributes,
            spritePatterns: this.tables.patterns
        });
        this.vdp.setDisplayEnabled(true);
        this.display = 0;
        this.draw = 0;
    }

    /**
     * Which of the V9938's two sprite systems the mode has. 1 in the MSX1
     * modes - SCREEN 1, 2 and 3 - which is one colour a sprite and four to a
     * line; 2 everywhere else, which is a colour a line and eight to a line.
     */
    get spriteMode(): 1 | 2 {
        const name = this.vdp.mode.name;
        return name === "G1" || name === "G2" || name === "MC" ? 1 : 2;
    }

    /** How many pages there are to flip between: framebuffers, or in the pattern modes name tables. */
    get pages(): number {
        if (isPatternMode(this.vdp.mode.name)) return PATTERN_TABLES.pages;
        return this.vdp.mode.pages || 1;
    }

    get mode() {
        return this.vdp.mode;
    }

    get width(): number {
        return this.vdp.mode.width;
    }

    /**
     * How wide a pixel is against how tall, relative to the 256-pixel modes.
     *
     * The V9938 paints the same picture width whatever the mode, so SCREEN 6
     * and 7 get their 512 columns by halving the pixel rather than widening the
     * screen. Their pixels really are tall, and a host that draws them square
     * shows a picture stretched to twice its proper width.
     */
    get pixelAspect(): number {
        return 256 / this.vdp.mode.width;
    }

    get height(): number {
        return this.vdp.mode.height;
    }

    /** VRAM address where a page's framebuffer starts - or in the pattern modes, its name table. */
    pageBase(page: number): number {
        page %= this.pages;
        if (isPatternMode(this.vdp.mode.name)) return PATTERN_TABLES.names + (page >> 1) * 0x400 + (page & 1) * 0x8000;
        return page * this.vdp.mode.pageSize;
    }

    /**
     * How many lines of a page hold picture: every line R23 can scroll into
     * view (256, whatever the screen height), except on the page that holds the
     * sprite tables, which stops at the line they start on. `gfx.offscreen`
     * draws down to here. Outside the bitmap modes, just the screen.
     */
    pageLines(page: number): number {
        const mode = this.vdp.mode;
        if (!mode.bitmap || !mode.bytesPerLine) return mode.height;
        const lines = Math.min(256, mode.pageSize / mode.bytesPerLine);
        const base = this.pageBase(page);
        const tables = this.tables.colors;
        if (tables < base || tables >= base + mode.pageSize) return lines;
        return Math.min(lines, Math.floor((tables - base) / mode.bytesPerLine));
    }

    get displayPage(): number {
        return this.display;
    }

    get drawPage(): number {
        return this.draw;
    }

    /** Points the raster at a page. Only R2 moves; the sprite tables stay where they are. */
    setDisplayPage(page: number): void {
        this.display = page % this.pages;
        // Let the VDP work out R2: which of its bits carry the address, and
        // which have to be written as ones, differs by mode.
        this.vdp.setLayoutAddress(this.pageBase(this.display));
    }

    /** Chooses which page drawing lands in. Independent of what is displayed. */
    setDrawPage(page: number): void {
        this.draw = page % this.pages;
    }

    /**
     * Swaps the displayed and drawn pages. Call it after finishing a frame's
     * drawing to show it whole rather than half-built.
     */
    flip(): void {
        const shown = this.display;
        this.setDisplayPage(this.draw);
        this.setDrawPage(shown);
    }

    /**
     * Enables double buffering: draw on page 1 while page 0 is shown. In the
     * pattern modes the pages are name tables, so it is the characters that
     * are double buffered - the patterns and colours are shared.
     */
    useDoubleBuffer(): void {
        this.setDisplayPage(0);
        this.setDrawPage(1);
    }

    /**
     * Scrolls the display vertically. The page wraps at 256 lines, not 212.
     * The same as `scroll.y`, which is where the rest of scrolling lives.
     */
    setScroll(lines: number): void {
        this.scroll.y = lines;
    }

    setBackdrop(color: number): void {
        this.vdp.setBackdrop(color);
    }

    /**
     * The sixteen palette entries as they stand, in 3-bit components. The
     * registers are write-only on the chip, so this is a shadow of what was
     * written - which is what reducing a picture to them needs to know.
     */
    get palette(): ReadonlyArray<PaletteColor> {
        return this.vdp.palette;
    }

    /** Palette entry as 3-bit components, giving the V9938's 512 colours. */
    setColor(index: number, r: number, g: number, b: number): void {
        this.vdp.setPaletteEntry(index, r, g, b);
    }

    setPalette(colors: ReadonlyArray<readonly [number, number, number]>): void {
        this.vdp.setPalette(colors);
    }

    resetPalette(): void {
        this.vdp.resetPalette();
    }

    /** Advances the machine one frame, rendering everything set up so far. */
    frame(): void {
        this.machine.frame();
    }
}

/** Sprite tables for a mode with pages of `pageSize`, placed in the tail of page 0. */
function spriteTablesFor(pageSize: number): SpriteTables {
    const base = pageSize - SPRITE_TABLE_OFFSET;
    return { colors: base, attributes: base + 0x200, patterns: base + 0x400 };
}
