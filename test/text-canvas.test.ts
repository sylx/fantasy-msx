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

    /** Horizontal scale, as `setTransform` last left it. */
    scale = 1;

    setTransform(a: number): void {
        this.scale = a;
    }

    fillText(text: string, x: number, y: number): void {
        this.stamps.push({ text, x, y });
        const top = Math.round(y - this.size * ASCENT);
        const bottom = Math.round(y + this.size * DESCENT);
        const from = Math.round(x * this.scale);
        const to = Math.round((x + this.advance(text)) * this.scale);
        for (let row = Math.max(0, top); row < Math.min(this.canvas.height, bottom); ++row) {
            for (let column = Math.max(0, from); column < Math.min(this.canvas.width, to); ++column) {
                this.canvas.alpha[row * this.canvas.width + column] = 255;
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
    ({ font: "10px sans-serif", size: 10, letterSpacing: 0, align: "left", stretch: 1, ...extra });

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
