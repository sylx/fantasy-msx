// Display setup: mode, pages, palette and scrolling.
//
// SCREEN 5 gives 128KB of VRAM as four 32KB pages, of which a 256x212 image
// uses 0x6A00. The spare 0x1600 at the top of page 0 holds the sprite tables,
// which stay put while the framebuffer pages flip beneath them.

import { R, type ScreenModeName, type Vdp } from "../api/index.js";
import type { FantasyMachine } from "../core/machine.js";

/** Sprite tables live in the tail of page 0, out of the way of every framebuffer. */
export const SPRITE_COLOR_TABLE = 0x07400;
export const SPRITE_ATTRIBUTE_TABLE = 0x07600;
export const SPRITE_PATTERN_TABLE = 0x07800;

export class Screen {
    private display = 0;
    private draw = 0;

    constructor(private readonly vdp: Vdp, private readonly machine: FantasyMachine) {}

    /**
     * Sets up a bitmap screen. Geometry reaches the raster at the next vertical
     * sync, so the frame you call this in still renders with the old borders.
     */
    setMode(name: ScreenModeName = "G4"): void {
        this.vdp.setMode(name, 0);
        this.vdp.setTables({
            layout: 0,
            colors: 0,
            patterns: 0,
            spriteAttributes: SPRITE_COLOR_TABLE,   // attributes sit 512 bytes later
            spritePatterns: SPRITE_PATTERN_TABLE
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
        const address = this.pageBase(this.display);
        // R2's unused bits must stay 1, exactly as setTables() computes them.
        this.vdp.write(R.LAYOUT_TABLE, ((address >> 10) & 0x60) | 0x1f);
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
