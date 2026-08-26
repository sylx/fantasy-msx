// The browser rasteriser's own arithmetic, against a canvas that behaves like
// one without being one: a monospaced face half as wide as it is tall, whose
// fillText stamps a solid block where the glyphs would go. What is under test
// is the layout - how big the box comes out, where each line's origin lands -
// not the shapes, which are the browser's business.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { rasteriseWithCanvas, type ResolvedStyle } from "../src/bios/index.js";

const ADVANCE = 0.5;                    // of the em, per character
const ASCENT = 0.8;
const DESCENT = 0.2;

interface Stamp { text: string; x: number; y: number; }

class FakeContext {
    font = "10px sans-serif";
    letterSpacing = "0px";
    textBaseline = "alphabetic";
    fillStyle = "#000";
    readonly stamps: Stamp[] = [];

    constructor(readonly canvas: FakeCanvas) {}

    private get size(): number {
        return parseFloat(this.font.match(/(\d+(?:\.\d+)?)px/)![1]);
    }

    private advance(text: string): number {
        return text.length * (this.size * ADVANCE + parseFloat(this.letterSpacing));
    }

    measureText(text: string) {
        const width = this.advance(text);
        return {
            width,
            actualBoundingBoxLeft: 0,
            actualBoundingBoxRight: width,
            actualBoundingBoxAscent: this.size * ASCENT,
            actualBoundingBoxDescent: this.size * DESCENT,
            fontBoundingBoxAscent: this.size * ASCENT,
            fontBoundingBoxDescent: this.size * DESCENT
        };
    }

    /** Horizontal scale and vertical offset, as `setTransform` last left them. */
    scale = 1;
    offset = 0;

    /**
     * How far below the baseline this face hangs its rows, as a fraction of
     * the em - so it scales with the size, the way a real face's design does.
     * Zero is a face on the grid; a twentieth of the em is half a pixel at ten
     * pixels an em, which is the bitmap face this all exists for.
     */
    static grid = 0;

    setTransform(a: number, _b = 0, _c = 0, _d = 1, _e = 0, f = 0): void {
        this.scale = a;
        this.offset = f;
    }

    clearRect(x: number, y: number, width: number, height: number): void {
        for (let row = y; row < Math.min(this.canvas.height, y + height); ++row) {
            this.canvas.alpha.fill(0, row * this.canvas.width + x,
                row * this.canvas.width + Math.min(this.canvas.width, x + width));
        }
    }

    /**
     * A solid block where the glyphs would go, laid down as coverage rather
     * than as ink: a row the block only half covers comes back half lit, which
     * is what a face off the grid does to a real one and the whole of what
     * `snap` is looking for.
     */
    fillText(text: string, x: number, y: number): void {
        this.stamps.push({ text, x, y });
        const shift = this.size * FakeContext.grid;
        const top = y - this.size * ASCENT + shift + this.offset;
        const bottom = y + this.size * DESCENT + shift + this.offset;
        const from = Math.round(x * this.scale);
        const to = Math.round((x + this.advance(text)) * this.scale);
        for (let row = Math.max(0, Math.floor(top)); row < Math.min(this.canvas.height, Math.ceil(bottom)); ++row) {
            const covered = Math.max(0, Math.min(row + 1, bottom) - Math.max(row, top));
            const value = Math.round(covered * 255);
            for (let column = Math.max(0, from); column < Math.min(this.canvas.width, to); ++column) {
                const at = row * this.canvas.width + column;
                this.canvas.alpha[at] = Math.max(this.canvas.alpha[at], value);
            }
        }
    }

    getImageData(x: number, y: number, width: number, height: number) {
        const data = new Uint8ClampedArray(width * height * 4);
        for (let i = 0; i < width * height; ++i) data[i * 4 + 3] = this.canvas.alpha[i];
        return { width, height, data };
    }
}

class FakeCanvas {
    private w = 1;
    private h = 1;
    alpha = new Uint8Array(1);
    readonly context = new FakeContext(this);

    get width(): number { return this.w; }
    get height(): number { return this.h; }
    // Resizing clears the bitmap, exactly as a real canvas does.
    set width(value: number) { this.w = value; this.reset(); }
    set height(value: number) { this.h = value; this.reset(); }

    private reset(): void {
        this.alpha = new Uint8Array(this.w * this.h);
        this.context.scale = 1;                     // a resize clears the transform too
    }

    getContext(): FakeContext { return this.context; }
}

const canvases: FakeCanvas[] = [];
const original = (globalThis as Record<string, unknown>).OffscreenCanvas;
(globalThis as Record<string, unknown>).OffscreenCanvas = class {
    constructor() {
        const canvas = new FakeCanvas();
        canvases.push(canvas);
        return canvas as unknown as OffscreenCanvas;
    }
};
afterAll(() => { (globalThis as Record<string, unknown>).OffscreenCanvas = original; });

/** What the rasteriser drew, on the one canvas it keeps once it has made it. */
function stamps(): Stamp[] {
    return canvases[0]?.context.stamps ?? [];
}

const style = (extra: Partial<ResolvedStyle> = {}): ResolvedStyle =>
    ({ font: "10px sans-serif", size: 10, letterSpacing: 0, align: "left", stretch: 1, snap: false, ...extra });

beforeEach(() => { stamps().length = 0; });

describe("The browser rasteriser", () => {
    it("sizes the box to the type and puts the baseline where the face asks", () => {
        const coverage = rasteriseWithCanvas("abcd", style());
        expect(coverage.width).toBe(20);            // four characters at half an em
        expect(coverage.height).toBe(10);           // ascent and descent
        expect(coverage.baseline).toBe(8);
        expect(coverage.lineHeight).toBe(10);
        // The block the fake stamped fills the box.
        expect(coverage.alpha[0]).toBe(255);
        expect(coverage.alpha[coverage.width * coverage.height - 1]).toBe(255);
    });

    it("stacks lines at the line height and sizes the box to the widest", () => {
        const coverage = rasteriseWithCanvas("ab\nabcd\n", style());
        expect(coverage.width).toBe(20);
        expect(coverage.height).toBe(30);           // three lines, the last one empty
        expect(stamps().map((s) => s.y)).toEqual([8, 18]);
        expect(stamps().length).toBe(2);            // nothing is drawn for an empty line
    });

    it("takes the line height it is given rather than the face's", () => {
        const coverage = rasteriseWithCanvas("ab\ncd", style({ lineHeight: 16 }));
        expect(coverage.lineHeight).toBe(16);
        expect(coverage.height).toBe(26);           // 8 + 2 of the last line, 16 before it
        expect(stamps().map((s) => s.y)).toEqual([8, 24]);
    });

    it("aligns short lines against the widest one", () => {
        rasteriseWithCanvas("ab\nabcd", style({ align: "center" }));
        expect(stamps().map((s) => s.x)).toEqual([5, 0]);

        stamps().length = 0;
        rasteriseWithCanvas("ab\nabcd", style({ align: "right" }));
        expect(stamps().map((s) => s.x)).toEqual([10, 0]);
    });

    it("draws the em twice as wide where the mode's pixels are tall", () => {
        const square = rasteriseWithCanvas("abcd", style());
        const tall = rasteriseWithCanvas("abcd", style({ stretch: 2 }));

        // Twice across, the same down: type of the same shape, at twice the
        // horizontal detail - which is what SCREEN 7 is for.
        expect(tall.width).toBe(square.width * 2);
        expect(tall.height).toBe(square.height);
        expect(tall.baseline).toBe(square.baseline);
        // The origin is passed in the font's own pixels, and the scale widens it.
        expect(stamps().at(-1)!.x).toBe(0);
        expect(tall.alpha[tall.width - 1]).toBe(255);
    });

    it("aligns against the stretched box, not the font's own measure", () => {
        rasteriseWithCanvas("ab\nabcd", style({ stretch: 2, align: "right" }));
        // Ten font pixels of slack, which the scale makes twenty on the page -
        // and the origin goes back through it as ten.
        expect(stamps().map((s) => s.x)).toEqual([10, 0]);
    });

    it("counts letter spacing in the width, since the browser counts it in the layout", () => {
        expect(rasteriseWithCanvas("abcd", style({ letterSpacing: 2 })).width).toBe(28);
        expect(rasteriseWithCanvas("abcd", style({ letterSpacing: -1 })).width).toBe(16);
    });

    it("gives an empty string a box of the face's height rather than nothing", () => {
        const coverage = rasteriseWithCanvas("", style());
        expect(coverage.width).toBe(1);
        expect(coverage.height).toBe(10);
        expect(stamps().length).toBe(0);
    });
});

/**
 * A bitmap face is only a bitmap where its own grid lands on the machine's.
 * The fake face here hangs its rows half a pixel below the baseline at ten
 * pixels an em, which is what the dot face does: every row of dots straddles
 * two of ours, and a browser that grid-fits rounds that outwards into two rows
 * of ink. `snap` cuts the face four times as big, where a rounding of that
 * kind is a quarter of one of our pixels, and folds it back four rows to one
 * on the seam that lands the face's grid on ours.
 */
describe("Cutting a bitmap face", () => {
    beforeEach(() => { FakeContext.grid = 0.05; });          // half a pixel at ten
    afterAll(() => { FakeContext.grid = 0; });

    /** Coverage that is neither ink nor paper, which is what a face off the grid leaves. */
    const grey = (coverage: { alpha: Uint8Array | Uint8ClampedArray }) =>
        [...coverage.alpha].filter((value) => value > 16 && value < 239).length;

    it("leaves a face off the grid half covered where it is not asked to snap", () => {
        expect(grey(rasteriseWithCanvas("abcd", style()))).toBeGreaterThan(0);
    });

    it("cuts the face at four times the size and folds it back", () => {
        const coverage = rasteriseWithCanvas("abcd", style({ snap: true }));
        // One rasterisation, at four times the em: the folding is arithmetic.
        expect(stamps().length).toBe(1);
        expect(canvases[0].context.font).toBe("40px sans-serif");
        expect(coverage.width).toBe(20);                    // the box is the box
        expect(coverage.baseline).toBe(8);
    });

    it("folds on the seam that lands the face's rows on whole pixels", () => {
        const coverage = rasteriseWithCanvas("abcd", style({ snap: true }));
        expect(grey(coverage)).toBe(0);
        // Half a pixel low is a whole row low once it is on the grid, so the
        // spare row is where the last of the ink went.
        expect(coverage.height).toBe(11);
        expect(coverage.alpha[0]).toBe(0);
        expect(coverage.alpha[coverage.width]).toBe(255);
        expect(coverage.alpha[coverage.width * 10]).toBe(255);
    });

    it("keeps the box it had where the face is already on the grid", () => {
        FakeContext.grid = 0;
        const coverage = rasteriseWithCanvas("abcd", style({ snap: true }));
        expect(coverage.height).toBe(10);
        expect(grey(coverage)).toBe(0);
        expect(coverage.alpha[0]).toBe(255);
    });
});
