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
// Coordinates are pixels in the current mode, and the packing follows it: the
// V9938 puts 4 pixels in a byte in GRAPHIC5, 2 in GRAPHIC4 and GRAPHIC6, and 1
// in GRAPHIC7 - always with the leftmost pixel in the highest bits.

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

    /** Pixels packed into one byte: 4 in GRAPHIC5, 2 in GRAPHIC4/6, 1 in GRAPHIC7. */
    private get pack(): number {
        return this.screen.mode.pixelsPerByte || 1;
    }

    /** Every bit of a colour the current mode can actually store. */
    private get colorMask(): number {
        return this.screen.mode.colors - 1;
    }

    // --- Primitives -------------------------------------------------------

    /** Fills the whole page, ignoring the clip rectangle. */
    clear(color = 0): void {
        const start = this.base;
        this.vram.fill(this.replicate(color), start, start + this.screen.height * this.stride);
    }

    pixel(x: number, y: number, color: number): void {
        const c = this.clipRect;
        if (x < c.x || y < c.y || x >= c.x + c.width || y >= c.y + c.height) return;
        this.writePixel(this.base + y * this.stride + ((x / this.pack) | 0), x, color);
    }

    getPixel(x: number, y: number, page = this.screen.drawPage): number {
        if (x < 0 || y < 0 || x >= this.screen.width || y >= this.screen.height) return 0;
        return this.readPixel(this.screen.pageBase(page) + y * this.stride, x);
    }

    /** Horizontal run. Whole bytes are filled at once; the ends go pixel by pixel. */
    hline(x: number, y: number, width: number, color: number): void {
        const c = this.clipRect;
        if (y < c.y || y >= c.y + c.height) return;

        let x0 = Math.max(x, c.x);
        const x1 = Math.min(x + width, c.x + c.width);     // exclusive
        if (x0 >= x1) return;

        const row = this.base + y * this.stride;
        const pack = this.pack;
        const value = color & this.colorMask;

        // The ends of the run may share a byte with pixels that must survive,
        // so they go one at a time and only whole bytes get filled.
        let end = x1;
        while (x0 < end && x0 % pack !== 0) {
            this.writePixel(row + ((x0 / pack) | 0), x0, value);
            ++x0;
        }
        while (end > x0 && end % pack !== 0) {
            --end;
            this.writePixel(row + ((end / pack) | 0), end, value);
        }
        if (x0 < end) this.vram.fill(this.replicate(value), row + x0 / pack, row + end / pack);
    }

    vline(x: number, y: number, height: number, color: number): void {
        const c = this.clipRect;
        if (x < c.x || x >= c.x + c.width) return;

        const y0 = Math.max(y, c.y);
        const y1 = Math.min(y + height, c.y + c.height);
        let address = this.base + y0 * this.stride + ((x / this.pack) | 0);
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

        const pack = this.pack;
        if (!transparent && sx % pack === 0 && dx % pack === 0 && width % pack === 0
            && dy >= this.clipRect.y && dy < this.clipRect.y + this.clipRect.height
            && dx >= this.clipRect.x && dx + width <= this.clipRect.x + this.clipRect.width) {
            const dest = this.base + dy * this.stride + dx / pack;
            this.vram.copyWithin(dest, source + sx / pack, source + (sx + width) / pack);
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
                const color = pixels[row * width + column] & this.colorMask;
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

    // --- Pixel packing -----------------------------------------------------

    private writePixel(address: number, x: number, color: number): void {
        const pack = this.pack;
        if (pack === 1) {
            this.vram[address] = color & 0xff;
            return;
        }
        const bits = 8 / pack;
        // The leftmost pixel of a byte lives in its highest bits.
        const shift = (pack - 1 - (x % pack)) * bits;
        const mask = ((1 << bits) - 1) << shift;
        this.vram[address] = (this.vram[address] & ~mask) | ((color << shift) & mask);
    }

    private readPixel(rowAddress: number, x: number): number {
        const pack = this.pack;
        const byte = this.vram[rowAddress + ((x / pack) | 0)];
        if (pack === 1) return byte;
        const bits = 8 / pack;
        return (byte >> ((pack - 1 - (x % pack)) * bits)) & ((1 << bits) - 1);
    }

    /** A byte holding `color` in each of the pixels it packs. */
    private replicate(color: number): number {
        let byte = color & this.colorMask;
        for (let width = 8 / this.pack; width < 8; width <<= 1) byte |= byte << width;
        return byte & 0xff;
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
