// Text in the host's fonts.
//
// The 6x8 font behind `gfx.text` is the machine's own - seven rows of five
// pixels, the shapes an MSX had in ROM. This is the other kind of text: a real
// typeface, laid out and rasterised by the browser on a canvas the machine
// never sees, then carried into VRAM one byte per pixel like any other picture.
//
// What crosses that boundary is coverage - how much of each pixel the glyphs
// cover, 0 to 255. The machine has no such quantity: a pixel is an index into
// sixteen registers and nothing in between, so the coverage has to be spent on
// indices that already exist. `shades` is where you say which: a ramp of them,
// palest to fullest, and the coverage picks along it. Give one shade and the
// edges are as hard as the machine's own font; give three and the flank of a
// stroke resolves into them.
//
// Which is to say the palette is an input here, as it is for pictures. Nothing
// in this module chooses a colour, searches for a near one or repaints a
// register: sixteen entries is a budget, how much of it type is worth is the
// app's decision, and a ramp is how that decision gets said.

import type { Graphics } from "./gfx.js";

/** Where a short line sits inside a box the widest one decided. */
export type TextAlign = "left" | "center" | "right";

export interface TextStyle {
    /** A CSS family list - `"serif"`, `"'Press Start 2P', monospace"`. Default `"sans-serif"`. */
    font?: string;
    /** Em size in pixels of the machine, not of the page. Default 16. */
    size?: number;
    /** CSS weight: a number, or `"bold"`. Default normal. */
    weight?: number | string;
    italic?: boolean;
    /** Baseline to baseline, in pixels. Defaults to what the face asks for. */
    lineHeight?: number;
    /** Added between characters, in pixels. Negative tightens. Default 0. */
    letterSpacing?: number;
    /** Default `"left"`. */
    align?: TextAlign;
    /** The index the glyphs are drawn in. Default 15. A ramp of one, in the terms below. */
    color?: number;
    /**
     * The indices partly-covered pixels are drawn in, palest first and fullest
     * last, in place of `color`. This is the whole of the antialiasing here:
     * coverage is divided by the length of the ramp, and each pixel takes the
     * entry its share lands on - nothing is blended, searched for, or written
     * into a palette register.
     *
     * `[1]` is the plain hard edge. `[8, 15]` gives a stroke one soft step,
     * `[8, 7, 15]` two. Order matters and the machine cannot check it: a ramp
     * that does not run from nearest-the-background to nearest-the-ink comes
     * out looking outlined rather than smoothed - which is occasionally what
     * you want, and `[15, 8, 15]` is how you would ask for it.
     *
     * Every entry is a register the type has taken off whatever else is on
     * screen, so three shades is usually the most a sixteen-colour mode can
     * afford, and one is what small text should stay at: at ten pixels an em
     * there is no flank to resolve, only a blur where the stem was.
     */
    shades?: readonly number[];
    /** The index behind them. Left out, the box is transparent and only the glyphs land. */
    background?: number;
    /**
     * Where the ramp sits against the coverage, 0 to 255. Default 128, which
     * puts a one-shade ramp's edge at half cover - the usual meaning of a
     * threshold. Lower fattens every stroke and pulls the whole ramp towards
     * the ink, which is often what small text on a 256-pixel screen wants;
     * higher thins it.
     */
    threshold?: number;
}

/** A style with every question answered, which is what the rasteriser is handed. */
export interface ResolvedStyle {
    /** Ready for `ctx.font`: the shorthand, already assembled. */
    readonly font: string;
    readonly size: number;
    /** Baseline to baseline, or undefined to let the face decide. */
    readonly lineHeight?: number;
    readonly letterSpacing: number;
    readonly align: TextAlign;
}

/** What the host hands back: coverage per pixel, and where the type sits in it. */
export interface Coverage {
    readonly width: number;
    readonly height: number;
    /** 0 to 255, row by row: how much of each pixel the glyphs cover. */
    readonly alpha: Uint8Array | Uint8ClampedArray;
    /** Rows from the top of the box down to the first line's baseline. */
    readonly baseline: number;
    /** Baseline to baseline, as the rasteriser actually spaced them. */
    readonly lineHeight: number;
}

/** What turns a string into coverage. Replaceable, for hosts with no browser in them. */
export type TextRasteriser = (text: string, style: ResolvedStyle) => Coverage;

/** The box a string occupies, and the landmarks inside it. */
export interface TextBox {
    readonly width: number;
    readonly height: number;
    /** Rows from the top of the box down to the first baseline. */
    readonly baseline: number;
    readonly lineHeight: number;
    readonly lines: number;
}

/** A string reduced to indices, ready for VRAM. */
export interface TextImage extends TextBox {
    /** One byte per pixel: the colour where there is ink, the background where there is not. */
    readonly pixels: Uint8Array;
    /** True when index 0 means "leave what is already there" - no background was asked for. */
    readonly transparent: boolean;
}

/** Rendered strings worth keeping, since a HUD asks for the same one every frame. */
const CACHE_LIMIT = 128;

export class Typesetter {
    /**
     * How a string becomes coverage. The default asks the browser, which brings
     * with it every font the page can see. Under Node there is nothing to ask,
     * so assign a rasteriser of your own.
     */
    rasteriser: TextRasteriser = rasteriseWithCanvas;

    /**
     * What every call starts from, so an app can choose its face once and then
     * pass only what changes.
     */
    style: TextStyle = {};

    private readonly cache = new Map<string, TextImage>();

    constructor(private readonly gfx: Graphics) {}

    /** The box a string will occupy, for centring and layout, without drawing it. */
    measure(text: string, style: TextStyle = {}): TextBox {
        const { width, height, baseline, lineHeight, lines } = this.render(text, style);
        return { width, height, baseline, lineHeight, lines };
    }

    /**
     * Lays a string out and reduces it to indices. Rendering is the expensive
     * half of this module, so the last hundred or so results are kept - which
     * is what makes a caption redrawn every frame cost nothing after the first.
     */
    render(text: string, style: TextStyle = {}): TextImage {
        const merged = { ...this.style, ...style };
        const resolved = resolve(merged);
        // A plain colour is a ramp of one, which is the whole difference
        // between antialiased text and the hard-edged kind.
        const ramp = merged.shades?.length ? merged.shades : [merged.color ?? 15];
        const background = merged.background;
        const threshold = merged.threshold ?? 128;

        const key = `${resolved.font}|${resolved.lineHeight ?? ""}|${resolved.letterSpacing}|${resolved.align}`
            + `|${ramp.join(",")}|${background ?? ""}|${threshold} ${text}`;
        const hit = this.cache.get(key);
        if (hit) {
            // Touch it, so what is drawn every frame is not what gets evicted.
            this.cache.delete(key);
            this.cache.set(key, hit);
            return hit;
        }

        const coverage = this.rasteriser(text, resolved);
        const image: TextImage = {
            width: coverage.width,
            height: coverage.height,
            baseline: coverage.baseline,
            lineHeight: coverage.lineHeight,
            lines: text.split("\n").length,
            transparent: background === undefined,
            pixels: quantise(coverage, ramp, background, threshold)
        };

        this.cache.set(key, image);
        if (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);
        return image;
    }

    /**
     * Queues a string for the blitter, which lays it down at the chip's pace -
     * a long line arrives left to right. `x` and `y` are the top left of the
     * box, and what comes back is the picture that was drawn - its box, and
     * the indices, should the caller want them again.
     */
    draw(x: number, y: number, text: string, style: TextStyle = {}): TextImage {
        const image = this.render(text, style);
        this.gfx.drawImage(x, y, image.width, image.height, image.pixels, image.transparent);
        return image;
    }

    /** The same, written straight into VRAM. A menu should not arrive in instalments. */
    drawNow(x: number, y: number, text: string, style: TextStyle = {}): TextImage {
        const image = this.render(text, style);
        this.gfx.now.drawImage(x, y, image.width, image.height, image.pixels, image.transparent);
        return image;
    }

    /**
     * Fetches a font file and makes it available under `family`, which is then
     * a name `style.font` can use. `source` is a URL, or any CSS `src` value.
     */
    async load(family: string, source: string, descriptors: FontFaceDescriptors = {}): Promise<void> {
        if (typeof FontFace !== "function" || typeof document === "undefined") {
            throw new Error("no font loader in this environment - only a browser can add a face");
        }
        const face = new FontFace(family, /\b(url|local)\(/.test(source) ? source : `url(${source})`, descriptors);
        await face.load();
        // The set is setlike in the specification and not in the DOM types.
        (document.fonts as FontFaceSet & { add(font: FontFace): void }).add(face);
        // Anything measured against the fallback is now wrong.
        this.forget();
    }

    /**
     * Waits for the fonts a style names to be usable. Worth an `await` in
     * `init`: a face still loading rasterises as the fallback, silently, and
     * the layout that comes out is the fallback's.
     */
    async ready(style: TextStyle = {}): Promise<void> {
        if (typeof document === "undefined" || !document.fonts) return;
        const resolved = resolve({ ...this.style, ...style });
        try {
            await document.fonts.load(resolved.font, "AZaz09");
        } catch {
            // An unparseable shorthand is the rasteriser's problem to report.
        }
        await document.fonts.ready;
        this.forget();
    }

    /** Drops everything rendered so far. Fonts arriving late is what this is for. */
    forget(): void {
        this.cache.clear();
    }
}

/** Fills in the defaults and assembles the CSS shorthand the host will want. */
function resolve(style: TextStyle): ResolvedStyle {
    const size = style.size ?? 16;
    const parts: string[] = [];
    if (style.italic) parts.push("italic");
    if (style.weight !== undefined) parts.push(String(style.weight));
    parts.push(`${size}px`, style.font ?? "sans-serif");

    return {
        font: parts.join(" "),
        size,
        lineHeight: style.lineHeight,
        letterSpacing: style.letterSpacing ?? 0,
        align: style.align ?? "left"
    };
}

/**
 * Coverage to indices, along the ramp.
 *
 * The coverage, biased by the threshold, is divided into as many bands as the
 * ramp is long plus one: the bottom band is the background and the rest take
 * the ramp in order. A ramp of one is exactly a threshold - `128` puts its
 * edge at half cover - so the hard-edged path and the antialiased one are the
 * same arithmetic, and moving the threshold slides a ramp of any length
 * towards the ink or away from it.
 */
function quantise(coverage: Coverage, ramp: readonly number[], background: number | undefined, threshold: number): Uint8Array {
    const pixels = new Uint8Array(coverage.width * coverage.height);
    // Uncovered means the background, and with none asked for that is index 0,
    // which the transfer skips rather than draws.
    if (background !== undefined && background !== 0) pixels.fill(background);

    const bias = 128 - threshold;
    for (let i = 0; i < pixels.length; ++i) {
        const level = Math.round((coverage.alpha[i] + bias) * ramp.length / 255);
        if (level > 0) pixels[i] = ramp[Math.min(level, ramp.length) - 1];
    }
    return pixels;
}

// --- The browser's rasteriser ---------------------------------------------

/** One canvas, reused: a HUD asks for this sixty times a second. */
let scratch: CanvasRenderingContext2D | null = null;

function context(): CanvasRenderingContext2D {
    if (scratch) return scratch;

    const canvas = typeof OffscreenCanvas === "function"
        ? new OffscreenCanvas(1, 1)
        : typeof document !== "undefined"
            ? Object.assign(document.createElement("canvas"), { width: 1, height: 1 })
            : null;
    if (!canvas) throw new Error("no text rasteriser in this environment - set bios.text.rasteriser");

    const found = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | null;
    // Outside a browser there may still be a canvas of sorts - the shim the VDP
    // renders into is one - but nothing in it can set type.
    if (!found || typeof found.measureText !== "function" || typeof found.fillText !== "function") {
        throw new Error("no text rasteriser in this environment - set bios.text.rasteriser");
    }

    scratch = found;
    return found;
}

/**
 * The default: lays the string out with the browser's own text engine and
 * reads the pixels back.
 *
 * Two passes over one canvas: measure, which decides how big the box is, then
 * draw, which needs the canvas at that size. Resizing a canvas resets its
 * context, so the font is set again in between.
 *
 * The measuring is the interesting half. A line is not as wide as its advance -
 * an italic f or a script tail hangs past both ends - so the box comes from the
 * bounding boxes the browser reports, and each line is drawn at its own origin
 * so that the overhang lands inside the picture rather than off the edge of it.
 */
export function rasteriseWithCanvas(text: string, style: ResolvedStyle): Coverage {
    const ctx = context();
    const lines = text.split("\n");

    apply(ctx, style);
    let left = 0;
    let right = 0;
    let ascent = 0;
    let descent = 0;
    const extents: Array<{ left: number; right: number }> = [];

    for (const line of lines) {
        const m = ctx.measureText(line);
        // Ink can start left of the origin and end past the advance.
        const lineLeft = Math.max(0, m.actualBoundingBoxLeft ?? 0);
        const lineRight = Math.max(m.width, m.actualBoundingBoxRight ?? 0);
        extents.push({ left: lineLeft, right: lineRight });
        left = Math.max(left, lineLeft);
        right = Math.max(right, lineRight);
        ascent = Math.max(ascent, m.fontBoundingBoxAscent ?? 0, m.actualBoundingBoxAscent ?? 0);
        descent = Math.max(descent, m.fontBoundingBoxDescent ?? 0, m.actualBoundingBoxDescent ?? 0);
    }

    // Some engines report no font box at all for an empty string; fall back to
    // the proportions a Latin face roughly keeps.
    if (ascent === 0 && descent === 0) {
        ascent = style.size * 0.8;
        descent = style.size * 0.2;
    }

    const baseline = Math.ceil(ascent);
    const lineHeight = Math.max(1, Math.round(style.lineHeight ?? ascent + descent));
    const width = Math.max(1, Math.ceil(left + right));
    const height = Math.max(1, baseline + Math.ceil(descent) + (lines.length - 1) * lineHeight);

    ctx.canvas.width = width;
    ctx.canvas.height = height;
    apply(ctx, style);                                  // the resize wiped all of it
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#fff";

    for (let i = 0; i < lines.length; ++i) {
        if (lines[i] === "") continue;
        // The origin is where the line's own overhang starts, shifted by
        // however much narrower than the box this line came out.
        const slack = width - (extents[i].left + extents[i].right);
        const indent = style.align === "center" ? slack / 2 : style.align === "right" ? slack : 0;
        ctx.fillText(lines[i], Math.round(extents[i].left + indent), baseline + i * lineHeight);
    }

    // White on nothing: the alpha channel is the coverage, and the other three
    // say no more than it does.
    const rgba = ctx.getImageData(0, 0, width, height).data;
    const alpha = new Uint8Array(width * height);
    for (let i = 0; i < alpha.length; ++i) alpha[i] = rgba[i * 4 + 3];

    return { width, height, alpha, baseline, lineHeight };
}

function apply(ctx: CanvasRenderingContext2D, style: ResolvedStyle): void {
    ctx.font = style.font;
    // Recent everywhere, and it must be set before measuring to be counted.
    if ("letterSpacing" in ctx) ctx.letterSpacing = `${style.letterSpacing}px`;
}
