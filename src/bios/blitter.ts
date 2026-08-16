// The blitter: drawing that takes the time the hardware would take.
//
// A V9938 does not fill a screen between two frames. It grinds through the
// rectangle a pixel at a time while the raster keeps sweeping, so you watch the
// fill arrive. WebMSX's own command engine writes the whole result the instant
// the command is issued and then merely holds its busy flag up, which means the
// slowness is real but invisible. This does it the other way round.
//
// Jobs are queued and advanced from the CPU's time slices - the same ones the
// VDP hands out between raster events, about ten per scanline. A job pins the
// page and clip it was queued with, so flipping pages later cannot make an
// unfinished fill paint over the wrong buffer.

import type { Raster, Rect } from "./raster.js";

/**
 * Cost per pixel in VDP cycles, measured against the emulated V9938 and close
 * to the chip's published figures. The byte-wise forms are the reason to keep
 * rectangles on even coordinates: they are eight times cheaper.
 */
export const COST = {
    /** HMMV: fills whole bytes, so two pixels at a time. */
    FILL_ALIGNED: 13.5,
    /** LMMV: reads, masks and writes each pixel. */
    FILL: 108,
    /** HMMM: byte-wise VRAM to VRAM. */
    COPY_ALIGNED: 24.5,
    /** LMMM: pixel-wise VRAM to VRAM. */
    COPY: 140,
    /** LINE, PSET and anything else plotted a point at a time. */
    PLOT: 108,
    /** LMMC / HMMC: pixels pushed in from outside, which is what text is. */
    TRANSFER: 120
} as const;

/** VDP cycles per CPU cycle. */
const VDP_CYCLE_RATIO = 6;

export interface Job {
    /** Units of work left. Zero means done. */
    readonly remaining: number;
    /** VDP cycles each unit costs. */
    readonly cyclesPerUnit: number;
    /** Does `units` worth of work against `raster`, which is already targeted. */
    advance(raster: Raster, units: number): void;
    readonly base: number;
    readonly clip: Rect;
}

abstract class BaseJob implements Job {
    constructor(readonly base: number, readonly clip: Rect) {}
    abstract get remaining(): number;
    abstract get cyclesPerUnit(): number;
    abstract advance(raster: Raster, units: number): void;
}

/** A solid rectangle, filled left to right and top to bottom. */
export class FillJob extends BaseJob {
    private cursor = 0;
    private readonly total: number;
    readonly cyclesPerUnit: number;

    constructor(
        base: number, clip: Rect,
        private readonly x: number, private readonly y: number,
        private readonly width: number, private readonly height: number,
        private readonly color: number
    ) {
        super(base, clip);
        this.total = Math.max(0, width) * Math.max(0, height);
        // Even edges let the chip move whole bytes and skip the read-modify-write.
        const aligned = (x & 1) === 0 && (width & 1) === 0;
        this.cyclesPerUnit = aligned ? COST.FILL_ALIGNED : COST.FILL;
    }

    get remaining(): number {
        return this.total - this.cursor;
    }

    advance(raster: Raster, units: number): void {
        let left = Math.min(units, this.remaining);
        while (left > 0) {
            const row = (this.cursor / this.width) | 0;
            const column = this.cursor - row * this.width;
            const run = Math.min(left, this.width - column);
            raster.hline(this.x + column, this.y + row, run, this.color);
            this.cursor += run;
            left -= run;
        }
    }
}

/** A rectangle of VRAM moved somewhere else, possibly from another page. */
export class CopyJob extends BaseJob {
    private cursor = 0;
    private readonly total: number;
    readonly cyclesPerUnit: number;

    constructor(
        base: number, clip: Rect,
        private readonly sourceBase: number,
        private readonly sx: number, private readonly sy: number,
        private readonly dx: number, private readonly dy: number,
        private readonly width: number, private readonly height: number,
        private readonly transparent: boolean
    ) {
        super(base, clip);
        this.total = Math.max(0, width) * Math.max(0, height);
        const aligned = !transparent && (sx & 1) === 0 && (dx & 1) === 0 && (width & 1) === 0;
        this.cyclesPerUnit = aligned ? COST.COPY_ALIGNED : COST.COPY;
    }

    get remaining(): number {
        return this.total - this.cursor;
    }

    advance(raster: Raster, units: number): void {
        let left = Math.min(units, this.remaining);
        while (left > 0) {
            const row = (this.cursor / this.width) | 0;
            const column = this.cursor - row * this.width;
            const run = Math.min(left, this.width - column);
            raster.copyRun(
                this.sourceBase, this.sx + column, this.sy + row,
                this.dx + column, this.dy + row, run, this.transparent
            );
            this.cursor += run;
            left -= run;
        }
    }
}

/** A line, plotted one point at a time in Bresenham order. */
export class LineJob extends BaseJob {
    readonly cyclesPerUnit = COST.PLOT;
    private x: number;
    private y: number;
    private error: number;
    private left: number;
    private readonly dx: number;
    private readonly dy: number;
    private readonly stepX: number;
    private readonly stepY: number;

    constructor(
        base: number, clip: Rect,
        x0: number, y0: number, x1: number, y1: number,
        private readonly color: number
    ) {
        super(base, clip);
        this.x = x0;
        this.y = y0;
        this.dx = Math.abs(x1 - x0);
        this.dy = -Math.abs(y1 - y0);
        this.stepX = x0 < x1 ? 1 : -1;
        this.stepY = y0 < y1 ? 1 : -1;
        this.error = this.dx + this.dy;
        this.left = Math.max(this.dx, -this.dy) + 1;
    }

    get remaining(): number {
        return this.left;
    }

    advance(raster: Raster, units: number): void {
        let count = Math.min(units, this.left);
        while (count-- > 0) {
            raster.pixel(this.x, this.y, this.color);
            --this.left;
            const doubled = this.error * 2;
            if (doubled >= this.dy) { this.error += this.dy; this.x += this.stepX; }
            if (doubled <= this.dx) { this.error += this.dx; this.y += this.stepY; }
        }
    }
}

/** A list of points: single pixels, circle outlines, anything irregular. */
export class PointsJob extends BaseJob {
    readonly cyclesPerUnit = COST.PLOT;
    private cursor = 0;

    /** `points` holds x and y interleaved. */
    constructor(base: number, clip: Rect, private readonly points: Int32Array, private readonly color: number) {
        super(base, clip);
    }

    get remaining(): number {
        return this.points.length / 2 - this.cursor;
    }

    advance(raster: Raster, units: number): void {
        const end = this.cursor + Math.min(units, this.remaining);
        for (; this.cursor < end; ++this.cursor) {
            raster.pixel(this.points[this.cursor * 2], this.points[this.cursor * 2 + 1], this.color);
        }
    }
}

/** Pixels pushed in from outside VRAM: images, and the glyphs of a string. */
export class TransferJob extends BaseJob {
    readonly cyclesPerUnit = COST.TRANSFER;
    private cursor = 0;

    constructor(
        base: number, clip: Rect,
        private readonly x: number, private readonly y: number,
        private readonly width: number, private readonly height: number,
        private readonly pixels: ArrayLike<number>,
        private readonly transparent: boolean
    ) {
        super(base, clip);
    }

    get remaining(): number {
        return this.width * this.height - this.cursor;
    }

    advance(raster: Raster, units: number): void {
        const end = this.cursor + Math.min(units, this.remaining);
        for (; this.cursor < end; ++this.cursor) {
            const color = this.pixels[this.cursor] & 0x0f;
            if (this.transparent && color === 0) continue;
            const row = (this.cursor / this.width) | 0;
            raster.pixel(this.x + this.cursor - row * this.width, this.y + row, color);
        }
    }
}

export class Blitter {
    private readonly queue: Job[] = [];
    private budget = 0;

    constructor(private readonly raster: Raster) {}

    push(job: Job): void {
        if (job.remaining > 0) this.queue.push(job);
    }

    /** Jobs still waiting, including the one being worked on. */
    get pending(): number {
        return this.queue.length;
    }

    get busy(): boolean {
        return this.queue.length > 0;
    }

    /** Pixels left across the whole queue - what a progress bar would show. */
    get work(): number {
        let total = 0;
        for (const job of this.queue) total += job.remaining;
        return total;
    }

    /** Throws away everything queued. The half-drawn job stays half-drawn. */
    abandon(): void {
        this.queue.length = 0;
        this.budget = 0;
    }

    /**
     * Spends a slice of CPU time on the queue. Called from the machine's cycle
     * hook, so a frame's worth of these adds up to a frame's worth of blitting.
     */
    step(cpuCycles: number): void {
        if (this.queue.length === 0) {
            this.budget = 0;            // idle time is not banked
            return;
        }

        this.budget += cpuCycles * VDP_CYCLE_RATIO;

        while (this.queue.length > 0) {
            const job = this.queue[0];
            const affordable = Math.floor(this.budget / job.cyclesPerUnit);
            if (affordable < 1) break;  // save up for the next slice

            const units = Math.min(affordable, job.remaining);
            this.raster.setTarget(job.base, job.clip);
            job.advance(this.raster, units);
            this.budget -= units * job.cyclesPerUnit;

            if (job.remaining > 0) break;
            this.queue.shift();
        }
    }
}
