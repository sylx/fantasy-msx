// Display setup: mode, pages, palette and scrolling.
//
// SCREEN 5 gives 128KB of VRAM as four 32KB pages, of which a 256x212 image
// uses 0x6A00. The spare 0x1600 at the top of page 0 holds the sprite tables,
// which stay put while the framebuffer pages flip beneath them.

import { type ScreenModeName, type Vdp } from "../api/index.js";
import type { FantasyMachine } from "../core/machine.js";

/**
 * Where the sprite tables sit inside page 0, measured back from the end of it.
 * A 256x212 image never fills a page - SCREEN 5 uses 0x6A00 of 0x8000, SCREEN 7
 * 0xD400 of 0x10000 - and this is the gap that leaves.
 */
const SPRITE_TABLE_OFFSET = 0x0c00;

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

    constructor(private readonly vdp: Vdp, private readonly machine: FantasyMachine) {}

    /**
     * Where the sprite tables live. They stay put in page 0 while the
     * framebuffer pages flip beneath them, but they do move when the mode
     * changes - a SCREEN 7 page is twice as long as a SCREEN 5 one.
     */
    get spriteTables(): SpriteTables {
        return this.tables;
    }

    /**
     * Sets up a bitmap screen. Geometry reaches the raster at the next vertical
     * sync, so the frame you call this in still renders with the old borders.
     */
    setMode(name: ScreenModeName = "G4"): void {
        this.vdp.setMode(name, 0);
        this.tables = spriteTablesFor(this.vdp.mode.pageSize || 0x8000);
        this.vdp.setTables({
            layout: 0,
            colors: 0,
            patterns: 0,
            spriteAttributes: this.tables.colors,   // attributes sit 512 bytes later
            spritePatterns: this.tables.patterns
        });
        this.vdp.setDisplayEnabled(true);
        this.display = 0;
        this.draw = 0;
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

    /** VRAM address where a page's framebuffer starts. */
    pageBase(page: number): number {
        return (page % this.vdp.mode.pages) * this.vdp.mode.pageSize;
    }

    get displayPage(): number {
        return this.display;
    }

    get drawPage(): number {
        return this.draw;
    }

    /** Points the raster at a page. Only R2 moves; the sprite tables stay where they are. */
    setDisplayPage(page: number): void {
        this.display = page % this.vdp.mode.pages;
        // Let the VDP work out R2: which of its bits carry the address, and
        // which have to be written as ones, differs by mode.
        this.vdp.setLayoutAddress(this.pageBase(this.display));
    }

    /** Chooses which page drawing lands in. Independent of what is displayed. */
    setDrawPage(page: number): void {
        this.draw = page % this.vdp.mode.pages;
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

    /** Enables double buffering: draw on page 1 while page 0 is shown. */
    useDoubleBuffer(): void {
        this.setDisplayPage(0);
        this.setDrawPage(1);
    }

    /** Scrolls the display vertically. The page wraps at 256 lines, not 212. */
    setScroll(lines: number): void {
        this.vdp.setVerticalOffset(lines);
    }

    setBackdrop(color: number): void {
        this.vdp.setBackdrop(color);
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
