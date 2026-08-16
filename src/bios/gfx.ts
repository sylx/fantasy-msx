// Drawing.
//
// Everything here writes VRAM directly. With TypeScript in the CPU's seat that
// costs no emulated time, which makes software rendering strictly faster than
// the V9938's blitter - a full-screen clear that the chip needs three frames
// for happens here inside one. The blitter is still reachable through
// `vdp.cmd` when you want the hardware's own timing.
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

export class Graphics {
    private readonly vram: Uint8Array;
    private clipRect: Rect;

    constructor(private readonly vdp: Vdp, private readonly screen: Screen) {
        this.vram = vdp.vram;
        this.clipRect = { x: 0, y: 0, width: screen.width, height: screen.height };
    }

    private get base(): number {
        return this.screen.pageBase(this.screen.drawPage);
    }

    private get stride(): number {
        return this.screen.mode.bytesPerLine;
    }

    // --- Clipping ---------------------------------------------------------

    /** Restricts drawing to a rectangle. Everything outside is left untouched. */
    setClip(x: number, y: number, width: number, height: number): void {
        const x0 = Math.max(0, x);
        const y0 = Math.max(0, y);
        this.clipRect = {
            x: x0,
            y: y0,
            width: Math.min(this.screen.width, x + width) - x0,
            height: Math.min(this.screen.height, y + height) - y0
        };
    }

    resetClip(): void {
        this.setClip(0, 0, this.screen.width, this.screen.height);
    }

    get clip(): Readonly<Rect> {
        return this.clipRect;
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
        const to = this.base;
        const stride = this.stride;

        // Byte-aligned, opaque copies move whole rows at a time.
        const aligned = !options.transparent && (sx & 1) === 0 && (dx & 1) === 0 && (width & 1) === 0;
        const down = dy > sy;                               // walk away from the overlap

        for (let i = 0; i < height; ++i) {
            const row = down ? height - 1 - i : i;
            const source = from + (sy + row) * stride;
            const dest = to + (dy + row) * stride;
            if (dy + row < 0 || dy + row >= this.screen.height) continue;

            if (aligned) {
                this.vram.copyWithin(dest + (dx >> 1), source + (sx >> 1), source + ((sx + width) >> 1));
            } else {
                for (let j = 0; j < width; ++j) {
                    const k = down ? width - 1 - j : j;
                    const value = this.readPixel(source, sx + k);
                    if (options.transparent && value === 0) continue;
                    this.pixel(dx + k, dy + row, value);
                }
            }
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
