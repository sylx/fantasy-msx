// The rasteriser: every primitive, drawn straight into VRAM.
//
// Nothing here takes emulated time. That is deliberate - this is the layer the
// blitter calls to do a slice of a job once it has earned the cycles for it,
// and it is also what `gfx.now` exposes for drawing that must not wait.
//
// The target page and clip rectangle are fields rather than arguments: a
// blitter job pins them to whatever was current when the job was queued, so
// later page flips cannot make it paint over the wrong page.
//
// Coordinates are pixels in the current mode. GRAPHIC4 packs two pixels per
// byte, the left one in the high nibble, 128 bytes to a line.

import type { Vdp } from "../api/index.js";
import { CHAR_HEIGHT, CHAR_WIDTH, FONT, glyphOffset } from "./font.js";
import type { Screen } from "./screen.js";

export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface BlitOptions {
    /** Skip source pixels of colour 0 instead of copying them. */
    transparent?: boolean;
    /** Page to read from. Defaults to the page being drawn on. */
    fromPage?: number;
}

export class Raster {
    private readonly vram: Uint8Array;
    private clipRect: Rect;

    /** VRAM address of the page being written. Set by whoever owns this rasteriser. */
    base: number;

    /** Clipping is owned by Graphics; setTarget is the only way to change it. */
    get clip(): Readonly<Rect> {
        return this.clipRect;
    }

    constructor(private readonly vdp: Vdp, private readonly screen: Screen) {
        this.vram = vdp.vram;
        this.base = screen.pageBase(screen.drawPage);
        this.clipRect = { x: 0, y: 0, width: screen.width, height: screen.height };
    }

    /** Points this rasteriser at a page and a clip rectangle in one go. */
    setTarget(base: number, clip: Rect): void {
        this.base = base;
        this.clipRect = clip;
    }

    private get stride(): number {
        return this.screen.mode.bytesPerLine;
    }

    // --- Primitives -------------------------------------------------------

    /** Fills the whole page, ignoring the clip rectangle. */
    clear(color = 0): void {
        const start = this.base;
        this.vram.fill((color & 0x0f) * 0x11, start, start + this.screen.height * this.stride);
    }

    pixel(x: number, y: number, color: number): void {
        const c = this.clipRect;
        if (x < c.x || y < c.y || x >= c.x + c.width || y >= c.y + c.height) return;
        this.writePixel(this.base + y * this.stride + (x >> 1), x, color);
    }

    getPixel(x: number, y: number, page = this.screen.drawPage): number {
        if (x < 0 || y < 0 || x >= this.screen.width || y >= this.screen.height) return 0;
        const byte = this.vram[this.screen.pageBase(page) + y * this.stride + (x >> 1)];
        return x & 1 ? byte & 0x0f : byte >> 4;
    }

    /** Horizontal run. The middle is filled a byte at a time, the ends by nibble. */
    hline(x: number, y: number, width: number, color: number): void {
        const c = this.clipRect;
        if (y < c.y || y >= c.y + c.height) return;

        let x0 = Math.max(x, c.x);
        const x1 = Math.min(x + width, c.x + c.width);     // exclusive
        if (x0 >= x1) return;

        const row = this.base + y * this.stride;
        const nibble = color & 0x0f;

        if (x0 & 1) {                                       // leading half byte
            this.writePixel(row + (x0 >> 1), x0, nibble);
            ++x0;
        }
        let end = x1;
        if (end & 1) {                                      // trailing half byte
            --end;
            this.writePixel(row + (end >> 1), end, nibble);
        }
        if (x0 < end) this.vram.fill(nibble * 0x11, row + (x0 >> 1), row + (end >> 1));
    }

    vline(x: number, y: number, height: number, color: number): void {
        const c = this.clipRect;
        if (x < c.x || x >= c.x + c.width) return;

        const y0 = Math.max(y, c.y);
        const y1 = Math.min(y + height, c.y + c.height);
        let address = this.base + y0 * this.stride + (x >> 1);
        for (let i = y0; i < y1; ++i, address += this.stride) this.writePixel(address, x, color);
    }

    fillRect(x: number, y: number, width: number, height: number, color: number): void {
        for (let i = 0; i < height; ++i) this.hline(x, y + i, width, color);
    }

    /** Outline only, one pixel thick, drawn inside the given rectangle. */
    rect(x: number, y: number, width: number, height: number, color: number): void {
        if (width <= 0 || height <= 0) return;
        this.hline(x, y, width, color);
        this.hline(x, y + height - 1, width, color);
        this.vline(x, y + 1, height - 2, color);
        this.vline(x + width - 1, y + 1, height - 2, color);
    }

    line(x0: number, y0: number, x1: number, y1: number, color: number): void {
        // Horizontal and vertical runs are common enough to be worth the shortcut.
        if (y0 === y1) return this.hline(Math.min(x0, x1), y0, Math.abs(x1 - x0) + 1, color);
        if (x0 === x1) return this.vline(x0, Math.min(y0, y1), Math.abs(y1 - y0) + 1, color);

        const dx = Math.abs(x1 - x0);
        const dy = -Math.abs(y1 - y0);
        const sx = x0 < x1 ? 1 : -1;
        const sy = y0 < y1 ? 1 : -1;
        let error = dx + dy;

        for (;;) {
            this.pixel(x0, y0, color);
            if (x0 === x1 && y0 === y1) return;
            const e2 = error * 2;
            if (e2 >= dy) { error += dy; x0 += sx; }
            if (e2 <= dx) { error += dx; y0 += sy; }
        }
    }

    circle(cx: number, cy: number, radius: number, color: number): void {
        this.walkCircle(radius, (dx, dy) => {
            this.pixel(cx + dx, cy + dy, color);
            this.pixel(cx - dx, cy + dy, color);
            this.pixel(cx + dx, cy - dy, color);
            this.pixel(cx - dx, cy - dy, color);
        });
    }

    fillCircle(cx: number, cy: number, radius: number, color: number): void {
        let lastY = -1;
        this.walkCircle(radius, (dx, dy) => {
            if (dy === lastY) return;                       // one span per scanline
            lastY = dy;
            this.hline(cx - dx, cy + dy, dx * 2 + 1, color);
            if (dy !== 0) this.hline(cx - dx, cy - dy, dx * 2 + 1, color);
        });
    }

    // --- Bulk moves -------------------------------------------------------

    /**
     * Copies a rectangle of VRAM. Source and destination may overlap, and
     * `fromPage` lets you pull from a page you are not drawing on - which is
     * how a background gets restored under a moving object.
     */
    blit(sx: number, sy: number, dx: number, dy: number, width: number, height: number, options: BlitOptions = {}): void {
        const from = this.screen.pageBase(options.fromPage ?? this.screen.drawPage);
        const transparent = !!options.transparent;
        const downwards = dy > sy;                          // walk away from the overlap

        for (let i = 0; i < height; ++i) {
            const row = downwards ? height - 1 - i : i;
            this.copyRun(from, sx, sy + row, dx, dy + row, width, transparent);
        }
    }

    /**
     * Copies one horizontal run of pixels from `sourceBase`. Byte-aligned runs
     * move whole bytes; the rest go a pixel at a time. This is the unit the
     * blitter works in, which is why it is a run rather than a rectangle.
     */
    copyRun(sourceBase: number, sx: number, sy: number, dx: number, dy: number, width: number, transparent: boolean): void {
        if (width <= 0) return;
        const source = sourceBase + sy * this.stride;

        if (!transparent && (sx & 1) === 0 && (dx & 1) === 0 && (width & 1) === 0
            && dy >= this.clipRect.y && dy < this.clipRect.y + this.clipRect.height
            && dx >= this.clipRect.x && dx + width <= this.clipRect.x + this.clipRect.width) {
            const dest = this.base + dy * this.stride + (dx >> 1);
            this.vram.copyWithin(dest, source + (sx >> 1), source + ((sx + width) >> 1));
            return;
        }

        for (let i = 0; i < width; ++i) {
            const value = this.readPixel(source, sx + i);
            if (transparent && value === 0) continue;
            this.pixel(dx + i, dy, value);
        }
    }

    /**
     * Draws an image given one byte per pixel. This is the format to author
     * sprites and tiles in - readable, and unpacked at draw time.
     */
    drawImage(x: number, y: number, width: number, height: number, pixels: ArrayLike<number>, transparent = true): void {
        for (let row = 0; row < height; ++row) {
            for (let column = 0; column < width; ++column) {
                const color = pixels[row * width + column] & 0x0f;
                if (transparent && color === 0) continue;
                this.pixel(x + column, y + row, color);
            }
        }
    }

    // --- Text -------------------------------------------------------------

    /**
     * Draws a string in the built-in 6x8 font. Passing `background` fills the
     * cell behind each character; leaving it out draws the glyphs only.
     */
    text(x: number, y: number, text: string, color = 15, background?: number): void {
        let cursorX = x;
        let cursorY = y;

        for (const character of text) {
            if (character === "\n") {
                cursorX = x;
                cursorY += CHAR_HEIGHT;
                continue;
            }

            if (background !== undefined) this.fillRect(cursorX, cursorY, CHAR_WIDTH, CHAR_HEIGHT, background);

            const glyph = glyphOffset(character.charCodeAt(0));
            for (let row = 0; row < CHAR_HEIGHT; ++row) {
                let bits = FONT[glyph + row];
                for (let column = 0; bits; ++column, bits = (bits << 1) & 0xff) {
                    if (bits & 0x80) this.pixel(cursorX + column, cursorY + row, color);
                }
            }
            cursorX += CHAR_WIDTH;
        }
    }

    /** Width in pixels a string will occupy, for centring and layout. */
    textWidth(text: string): number {
        let longest = 0;
        for (const line of text.split("\n")) longest = Math.max(longest, line.length);
        return longest * CHAR_WIDTH;
    }

    // --- Nibble plumbing ---------------------------------------------------

    private writePixel(address: number, x: number, color: number): void {
        this.vram[address] = x & 1
            ? (this.vram[address] & 0xf0) | (color & 0x0f)
            : (this.vram[address] & 0x0f) | ((color & 0x0f) << 4);
    }

    private readPixel(rowAddress: number, x: number): number {
        const byte = this.vram[rowAddress + (x >> 1)];
        return x & 1 ? byte & 0x0f : byte >> 4;
    }

    /** Midpoint circle, reporting one octant's worth of offsets mirrored eight ways. */
    private walkCircle(radius: number, plot: (dx: number, dy: number) => void): void {
        let x = radius;
        let y = 0;
        let error = 1 - radius;
        while (x >= y) {
            plot(x, y);
            plot(y, x);
            ++y;
            if (error < 0) error += 2 * y + 1;
            else { --x; error += 2 * (y - x) + 1; }
        }
    }
}
