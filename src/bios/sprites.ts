// Hardware sprites (V9938 sprite mode 2).
//
// This is the part of the VDP that TypeScript cannot undercut: 32 sprites
// composited by the chip as it scans each line, costing no VRAM writes and no
// time at all once set up. Moving objects belong here, not in the framebuffer.
//
// Mode 2 gives every sprite line its own colour, so a sprite can be shaded
// without spending a second sprite on it. Eight sprites per scanline is the
// hard limit; the ninth is dropped and flagged in S#0.
//
// A sprite's Y is a line of the page, not of the screen, so R23 carries the
// sprites along with the picture. Positions here are screen lines: each Y is
// written with the vertical scroll of the band it lands in added back, and
// written again at every vertical sync in case the scroll has moved since.

import { S, S0, type Vdp } from "../api/index.js";
import type { Screen } from "./screen.js";

export const SPRITE_COUNT = 32;

/** Y value that stops the VDP processing any further sprites this frame. */
const END_OF_LIST = 216;
/** What the attribute table's Y byte of each sprite is standing for. */
const PLACED = {
    /** Written by someone else - the end of the list, say. Left alone. */
    RAW: 0,
    /** On screen at a screen line. */
    SHOWN: 1,
    /** Parked on page lines no band shows. */
    HIDDEN: 2
} as const;

/** Per-line colour byte flags. */
export const SPRITE_FLAGS = {
    /** Shifts the sprite 32 pixels left, so it can slide in from off-screen. */
    EARLY_CLOCK: 0x80,
    /** Draws this sprite merged with the higher-priority one above it. */
    COMPOSITE: 0x40,
    /** Excludes this line from collision detection. */
    NO_COLLISION: 0x20
} as const;

export interface SpriteState {
    x: number;
    y: number;
    /** Pattern slot. 16x16 sprites round it down to a multiple of four. */
    pattern: number;
    /** A single colour, or one per line (16 entries) for a shaded sprite. */
    color: number | ArrayLike<number>;
    /** Extra per-line flags, ORed into every colour byte. */
    flags?: number;
}

export class Sprites {
    private readonly vram: Uint8Array;
    private size: 8 | 16 = 8;
    private magnified = false;
    private readonly placed = new Uint8Array(SPRITE_COUNT);
    /** Screen line of each shown sprite, before the scroll is added back. */
    private readonly lines = new Int16Array(SPRITE_COUNT);

    constructor(private readonly vdp: Vdp, private readonly screen: Screen) {
        this.vram = vdp.vram;
        this.hideAll();
    }

    /** Table addresses follow the screen mode, since page sizes differ. */
    private get tables() {
        return this.screen.spriteTables;
    }

    /** 8x8 or 16x16, optionally with every pixel doubled. */
    setSize(size: 8 | 16, magnified = false): void {
        this.size = size;
        this.magnified = magnified;
        this.vdp.setSprites({ size, magnified });
    }

    /** All sprites on or off. A scroll band can still hide them on its own lines. */
    setEnabled(enabled: boolean): void {
        this.screen.scroll.setSpritesEnabled(enabled);
    }

    /**
     * Loads a pattern. Pass 8 rows of 8 bits for an 8x8 sprite, or 16 rows of
     * 16 bits for a 16x16 one - the four-quadrant order the chip actually wants
     * is worked out here.
     */
    setPattern(slot: number, rows: ArrayLike<number>): void {
        const base = this.tables.patterns + (slot & 0xff) * 8;
        if (rows.length <= 8) {
            for (let y = 0; y < 8; ++y) this.vram[base + y] = (rows[y] ?? 0) & 0xff;
            return;
        }
        // 16x16: the left half occupies the first 16 bytes, the right half the next.
        for (let y = 0; y < 16; ++y) {
            this.vram[base + y] = ((rows[y] ?? 0) >> 8) & 0xff;
            this.vram[base + 16 + y] = (rows[y] ?? 0) & 0xff;
        }
    }

    /**
     * Reads a pattern out of a string bitmap, which is how sprite art is worth
     * writing: one string per row, any character other than space or "." set.
     */
    setPatternFromBitmap(slot: number, bitmap: readonly string[]): void {
        const width = bitmap.length <= 8 ? 8 : 16;
        const rows = bitmap.map((row) => {
            let bits = 0;
            for (let x = 0; x < row.length && x < width; ++x) {
                if (row[x] !== " " && row[x] !== ".") bits |= 1 << (width - 1 - x);
            }
            return bits;
        });
        this.setPattern(slot, rows);
    }

    /** Places a sprite. `y` is the screen line its top row appears on. */
    set(index: number, state: SpriteState): void {
        const attribute = this.tables.attributes + index * 4;
        this.place(index, state.y);
        this.vram[attribute + 1] = state.x & 0xff;
        this.vram[attribute + 2] = this.size === 16 ? state.pattern & 0xfc : state.pattern & 0xff;
        this.vram[attribute + 3] = 0;

        const colors = this.tables.colors + index * 16;
        const flags = state.flags ?? 0;
        if (typeof state.color === "number") {
            this.vram.fill((state.color & 0x0f) | flags, colors, colors + 16);
        } else {
            for (let line = 0; line < 16; ++line) {
                this.vram[colors + line] = ((state.color[line] ?? 0) & 0x0f) | flags;
            }
        }
    }

    /** Moves a sprite without touching its pattern or colours. */
    move(index: number, x: number, y: number): void {
        this.place(index, y);
        this.vram[this.tables.attributes + index * 4 + 1] = x & 0xff;
    }

    /** Replaces the per-line colours of a sprite already placed. */
    setLineColors(index: number, colors: ArrayLike<number>, flags = 0): void {
        const base = this.tables.colors + index * 16;
        for (let line = 0; line < 16; ++line) this.vram[base + line] = ((colors[line] ?? 0) & 0x0f) | flags;
    }

    /** Parks one sprite off-screen. The rest keep being drawn. */
    hide(index: number): void {
        this.placed[index] = PLACED.HIDDEN;
        this.writeY(index, this.parking());
    }

    hideAll(): void {
        for (let i = 0; i < SPRITE_COUNT; ++i) this.hide(i);
    }

    /**
     * Stops the VDP after `count` sprites. Cheaper than hiding them one by one,
     * and the only way to tell the chip not to look at the rest at all.
     */
    setActiveCount(count: number): void {
        if (count < SPRITE_COUNT) {
            this.placed[count] = PLACED.RAW;
            this.vram[this.tables.attributes + count * 4] = END_OF_LIST;
        }
    }

    /**
     * Rewrites every sprite's Y against the scroll as it stands. The BIOS does
     * this at each vertical sync, so a sprite stays on its screen line while
     * the picture moves under it.
     */
    follow(): void {
        const parking = this.parking();
        for (let i = 0; i < SPRITE_COUNT; ++i) if (this.placed[i] !== PLACED.RAW) this.writeY(i, parking);
    }

    private place(index: number, y: number): void {
        this.placed[index] = PLACED.SHOWN;
        this.lines[index] = Math.round(y);
        this.writeY(index);
    }

    /**
     * Where hidden sprites go: page lines no band shows. Below the screen when
     * nothing scrolls - but a band can point anywhere in the page, and a sprite
     * parked where one is looking would turn up in it.
     */
    private parking(): number {
        return this.screen.scroll.unseenLine(this.height);
    }

    /** Lines a sprite covers on screen. */
    private get height(): number {
        return this.size * (this.magnified ? 2 : 1);
    }

    private writeY(index: number, parking?: number): void {
        // The VDP draws a sprite one line below its stored Y. A sprite wholly
        // inside bands that hide sprites has no band to be written against, and
        // goes where hidden ones go.
        const band = this.placed[index] === PLACED.SHOWN
            ? this.screen.scroll.spriteBand(this.lines[index], this.height)
            : null;
        let y = band ? this.lines[index] - 1 + band.y : (parking ?? this.parking()) - 1;
        // 216 ends the list and takes every later sprite with it. One line of
        // error is the lesser loss.
        y &= 0xff;
        if (y === END_OF_LIST) ++y;
        this.vram[this.tables.attributes + index * 4] = y;
    }

    /**
     * Whether any two sprites overlapped, clearing the flag as the hardware
     * does. Read it once per frame: reading also clears the VBlank flag.
     */
    collided(): boolean {
        return (this.vdp.status(S.INTERRUPT) & S0.COLLISION) !== 0;
    }

    /** Where the last collision happened. Only meaningful right after `collided()`. */
    collisionPoint(): { x: number; y: number } {
        const x = this.vdp.status(S.COLLISION_X_LOW) | (this.vdp.status(S.COLLISION_X_HIGH) << 8);
        const y = this.vdp.status(S.COLLISION_Y_LOW) | (this.vdp.status(S.COLLISION_Y_HIGH) << 8);
        return { x: x - 12, y: y - 8 };     // the chip reports raster position, not screen position
    }

    /** True when more than eight sprites landed on one line and one was dropped. */
    overflowed(): boolean {
        return (this.vdp.status(S.INTERRUPT) & S0.FIFTH_SPRITE) !== 0;
    }
}
