// Drawing, as the machine actually does it.
//
// Every call here queues work for the blitter, which grinds through it at the
// V9938's own pace - a full-screen clear takes about two frames and you watch
// it arrive. That is the point: the slowness is the character of the machine,
// not a defect to hide.
//
// When something must land before the next frame - a HUD, a menu, the initial
// screen - reach for `gfx.now`, which is the same set of primitives written
// straight into VRAM at no cost. Use it deliberately; it is the exception.

import { Blitter, CopyJob, FillJob, LineJob, PointsJob, TransferJob } from "./blitter.js";
import { CHAR_HEIGHT, CHAR_WIDTH, FONT, glyphOffset } from "./font.js";
import type { BlitOptions, Raster, Rect } from "./raster.js";
import type { Screen } from "./screen.js";

export class Graphics {
    private clipRect: Rect;

    constructor(
        private readonly screen: Screen,
        private readonly blitter: Blitter,
        private readonly immediate: Raster
    ) {
        this.clipRect = { x: 0, y: 0, width: screen.width, height: screen.height };
    }

    /**
     * The same primitives, drawn immediately and for free. Everything it draws
     * is already on the page when it returns.
     */
    get now(): Raster {
        this.immediate.setTarget(this.pageBase(), this.clipRect);
        return this.immediate;
    }

    // --- Queue state ------------------------------------------------------

    /** True while the blitter still has work. */
    get busy(): boolean {
        return this.blitter.busy;
    }

    /** Queued jobs, including the one in progress. */
    get pending(): number {
        return this.blitter.pending;
    }

    /** Pixels left to draw across the whole queue. */
    get work(): number {
        return this.blitter.work;
    }

    /** Drops everything queued. Whatever was half-drawn stays half-drawn. */
    abandon(): void {
        this.blitter.abandon();
    }

    // --- Clipping ---------------------------------------------------------

    /**
     * Restricts drawing to a rectangle. Jobs capture the clip as they are
     * queued, so changing it later does not disturb work already in flight.
     */
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

    clear(color = 0): void {
        this.blitter.push(new FillJob(
            this.pageBase(), this.fullPage(), 0, 0, this.screen.width, this.screen.height, color
        ));
    }

    pixel(x: number, y: number, color: number): void {
        this.blitter.push(new PointsJob(this.pageBase(), this.capture(), Int32Array.of(x, y), color));
    }

    /** Reads a pixel back. Reads are free and immediate; only drawing is not. */
    getPixel(x: number, y: number, page = this.screen.drawPage): number {
        return this.now.getPixel(x, y, page);
    }

    hline(x: number, y: number, width: number, color: number): void {
        this.fillRect(x, y, width, 1, color);
    }

    vline(x: number, y: number, height: number, color: number): void {
        this.fillRect(x, y, 1, height, color);
    }

    /**
     * A solid rectangle. Even `x` and `width` let the chip move whole bytes,
     * which is eight times faster - worth arranging when you can.
     */
    fillRect(x: number, y: number, width: number, height: number, color: number): void {
        this.blitter.push(new FillJob(this.pageBase(), this.capture(), x, y, width, height, color));
    }

    rect(x: number, y: number, width: number, height: number, color: number): void {
        if (width <= 0 || height <= 0) return;
        this.fillRect(x, y, width, 1, color);
        this.fillRect(x, y + height - 1, width, 1, color);
        this.fillRect(x, y + 1, 1, height - 2, color);
        this.fillRect(x + width - 1, y + 1, 1, height - 2, color);
    }

    line(x0: number, y0: number, x1: number, y1: number, color: number): void {
        this.blitter.push(new LineJob(this.pageBase(), this.capture(), x0, y0, x1, y1, color));
    }

    circle(cx: number, cy: number, radius: number, color: number): void {
        const points: number[] = [];
        walkCircle(radius, (dx, dy) => {
            points.push(cx + dx, cy + dy, cx - dx, cy + dy, cx + dx, cy - dy, cx - dx, cy - dy);
        });
        this.blitter.push(new PointsJob(this.pageBase(), this.capture(), Int32Array.from(points), color));
    }

    fillCircle(cx: number, cy: number, radius: number, color: number): void {
        // The midpoint walk reports offsets by octant, which would make the
        // circle arrive in scattered bands. Collect the spans and queue them
        // top to bottom so it fills the way a scanline fill looks.
        const spans = new Map<number, number>();
        walkCircle(radius, (dx, dy) => {
            spans.set(cy + dy, Math.max(spans.get(cy + dy) ?? 0, dx));
            spans.set(cy - dy, Math.max(spans.get(cy - dy) ?? 0, dx));
        });

        const base = this.pageBase();
        const clip = this.capture();
        for (const y of [...spans.keys()].sort((a, b) => a - b)) {
            const dx = spans.get(y)!;
            this.blitter.push(new FillJob(base, clip, cx - dx, y, dx * 2 + 1, 1, color));
        }
    }

    /**
     * Moves a rectangle of VRAM. `fromPage` pulls from a page you are not
     * drawing on, which is how a background gets restored under something that
     * has moved.
     */
    blit(sx: number, sy: number, dx: number, dy: number, width: number, height: number, options: BlitOptions = {}): void {
        const source = this.screen.pageBase(options.fromPage ?? this.screen.drawPage);
        this.blitter.push(new CopyJob(
            this.pageBase(), this.capture(), source, sx, sy, dx, dy, width, height, !!options.transparent
        ));
    }

    /** Draws an image given one byte per pixel - the format to author art in. */
    drawImage(x: number, y: number, width: number, height: number, pixels: ArrayLike<number>, transparent = true): void {
        this.blitter.push(new TransferJob(this.pageBase(), this.capture(), x, y, width, height, pixels, transparent));
    }

    /**
     * Draws a string in the built-in 6x8 font. The glyphs are rasterised now
     * and pushed to VRAM by the blitter, so a long line arrives left to right.
     */
    text(x: number, y: number, text: string, color = 15, background?: number): void {
        const base = this.pageBase();
        const clip = this.capture();
        let line = 0;

        for (const source of text.split("\n")) {
            if (source.length > 0) {
                this.blitter.push(new TransferJob(
                    base, clip, x, y + line * CHAR_HEIGHT,
                    source.length * CHAR_WIDTH, CHAR_HEIGHT,
                    rasteriseText(source, color, background),
                    background === undefined
                ));
            }
            ++line;
        }
    }

    /** Width in pixels a string will occupy, for centring and layout. */
    textWidth(text: string): number {
        let longest = 0;
        for (const line of text.split("\n")) longest = Math.max(longest, line.length);
        return longest * CHAR_WIDTH;
    }

    // --- Internals --------------------------------------------------------

    private pageBase(): number {
        return this.screen.pageBase(this.screen.drawPage);
    }

    /** Snapshots the clip so a job is unaffected by later changes. */
    private capture(): Rect {
        return { ...this.clipRect };
    }

    private fullPage(): Rect {
        return { x: 0, y: 0, width: this.screen.width, height: this.screen.height };
    }
}

/** Renders a string into one byte per pixel, ready to be transferred. */
function rasteriseText(text: string, color: number, background?: number): Uint8Array {
    const width = text.length * CHAR_WIDTH;
    const pixels = new Uint8Array(width * CHAR_HEIGHT);
    if (background !== undefined) pixels.fill(background & 0x0f);

    for (let i = 0; i < text.length; ++i) {
        const glyph = glyphOffset(text.charCodeAt(i));
        for (let row = 0; row < CHAR_HEIGHT; ++row) {
            let bits = FONT[glyph + row];
            for (let column = 0; bits; ++column, bits = (bits << 1) & 0xff) {
                if (bits & 0x80) pixels[row * width + i * CHAR_WIDTH + column] = color & 0x0f;
            }
        }
    }
    return pixels;
}

/** Midpoint circle, reporting one octant's offsets for the caller to mirror. */
function walkCircle(radius: number, plot: (dx: number, dy: number) => void): void {
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
