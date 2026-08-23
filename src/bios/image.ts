// Pictures from outside the machine.
//
// A V9938 has no idea what a PNG is. What it has is a framebuffer of indices -
// four bits of them in GRAPHIC4 and 6, two in GRAPHIC5, and in GRAPHIC7 a byte
// that is the colour itself, three bits of green, three of red and two of blue.
// So the work between a URL and VRAM is a reduction, and the mode decides how
// severe it is.
//
// The palette is an input here, not an output. Loading a picture does not
// repaint the sixteen registers underneath everything already on screen: the
// colours it may use are the colours the VDP is showing. When a picture
// deserves its own palette, ask for one with `palette()`, load it with
// `screen.setPalette()`, and reduce against it afterwards.

import {
    MODES, color256Rgb, paletteRgb, rgbToColor256, rgbToPalette,
    type PaletteColor, type ScreenMode, type ScreenModeName
} from "../api/index.js";
import type { Graphics } from "./gfx.js";
import type { Screen } from "./screen.js";

/** Decoded pixels, four bytes each, as a canvas hands them over. */
export interface RgbaImage {
    readonly width: number;
    readonly height: number;
    /** RGBA, row by row. */
    readonly data: Uint8ClampedArray | Uint8Array;
}

/** What turns a URL into pixels. Replaceable, for hosts with no browser in them. */
export type ImageDecoder = (url: string) => Promise<RgbaImage>;

/** A picture reduced to one mode's colours: one byte per pixel, ready for VRAM. */
export interface IndexedImage {
    readonly width: number;
    readonly height: number;
    /** Palette indices, or in GRAPHIC7 the colour bytes themselves. */
    readonly pixels: Uint8Array;
    /** The mode these indices mean something in. */
    readonly mode: ScreenModeName;
}

/**
 * How the colours a mode does not have are faked.
 *
 * `none` picks the nearest colour and accepts the banding. `ordered` is the
 * 4x4 Bayer pattern - a fixed crosshatch that holds still when the picture
 * moves, and the one that reads as a machine of this vintage. `floyd-steinberg`
 * pushes each pixel's error into its neighbours, which resolves more detail at
 * the cost of a grain that crawls if the source is animated.
 */
export type Dither = "none" | "ordered" | "floyd-steinberg";

export type Fit = "contain" | "cover" | "stretch";

export interface ReduceOptions {
    /**
     * Target size in pixels of the mode. Given neither, a picture that fits on
     * screen is kept at its own size and one that does not is fitted to it.
     * Given one, the other follows the source's proportions.
     */
    width?: number;
    height?: number;
    /**
     * How the source fills a target both of whose sides were given. `contain`
     * fits it whole and comes out smaller on one axis, `cover` fills the target
     * and crops the overflow, `stretch` distorts. Default `contain`.
     */
    fit?: Fit;
    /**
     * Correct for the tall pixels of the 512-wide modes, so a picture keeps its
     * proportions rather than coming out squeezed. On by default, and only
     * relevant when the picture is being resized at all.
     */
    aspect?: boolean;
    /** Default `floyd-steinberg`. */
    dither?: Dither;
    /** How much of it, 0 to 1. Default 1. */
    ditherAmount?: number;
    /**
     * Colours to reduce against, as 3-bit triples. Defaults to the palette the
     * VDP is showing. Ignored in GRAPHIC7, which has no palette.
     */
    palette?: ReadonlyArray<PaletteColor>;
    /**
     * Indices the reduction may not use - reserve 0 when you need it to mean
     * transparent. Nothing to exclude in GRAPHIC7, whose colours are fixed.
     */
    exclude?: readonly number[];
    /** Source pixels less opaque than this become `transparentIndex`. 0-255, default 128. */
    alphaThreshold?: number;
    /** Where transparent source pixels land. Default 0. */
    transparentIndex?: number;
    /** Reduce for a mode other than the current one. */
    mode?: ScreenModeName;
}

export interface PaletteOptions extends Pick<ReduceOptions, "mode"> {
    /** Entries to fill. Defaults to what the mode can show, up to 16. */
    colors?: number;
    /**
     * Leading entries to leave exactly as they are. Reserve at least one when
     * colour 0 is doing duty as transparent, or the picture will paint holes.
     */
    reserve?: number;
    /** Source pixels less opaque than this take no part in the count. Default 128. */
    alphaThreshold?: number;
}

export interface DrawOptions {
    /** Skip pixels of colour 0 rather than drawing them. Off by default: a picture is not a sprite. */
    transparent?: boolean;
}

/** Weights for comparing colours: green carries most of the brightness, blue least. */
const WEIGHT_R = 2;
const WEIGHT_G = 4;
const WEIGHT_B = 3;

/** 4x4 Bayer, in the order the threshold rises. */
const BAYER = [
    0, 8, 2, 10,
    12, 4, 14, 6,
    3, 11, 1, 9,
    15, 7, 13, 5
];

export class Images {
    /**
     * How a URL becomes pixels. The default asks the browser, which handles
     * every format it can display. Under Node there is nothing to ask, so
     * assign a decoder of your own - tools/png.ts has one for PNG.
     */
    decoder: ImageDecoder = decodeWithBrowser;

    constructor(private readonly screen: Screen, private readonly gfx: Graphics) {}

    /** Fetches a picture and reduces it to the colours the mode can show. */
    async load(url: string, options: ReduceOptions = {}): Promise<IndexedImage> {
        return this.reduce(await this.decode(url), options);
    }

    /**
     * Fetches a picture and stops there, at full colour. Worth keeping hold of
     * when the same picture has to be reduced more than once - for another
     * screen mode, or against a palette that has since changed - since that
     * saves fetching and decoding it again.
     */
    decode(url: string): Promise<RgbaImage> {
        return this.decoder(url);
    }

    /**
     * The same reduction, on pixels already decoded - `image.decode` output, a
     * canvas's `getImageData`, or something generated. Reducing one picture for
     * several modes is this call, once each, rather than several loads.
     */
    reduce(source: RgbaImage, options: ReduceOptions = {}): IndexedImage {
        const mode = this.modeFor(options);
        const { rect, width, height } = fitSize(source, mode, options);
        const scaled = resample(source, rect, width, height);
        const palette = options.palette ?? this.screen.palette;

        return {
            width, height, mode: mode.name,
            pixels: quantize(scaled, width, height, buildTarget(mode, palette, options.exclude), options)
        };
    }

    /**
     * A palette chosen for a picture rather than for the machine, as 3-bit
     * triples ready for `screen.setPalette`.
     *
     * The result covers all 16 registers, with the reserved ones left at what
     * they are now, so loading it disturbs nothing you meant to keep.
     */
    palette(source: RgbaImage, options: PaletteOptions = {}): PaletteColor[] {
        const mode = this.modeFor(options);
        const reserve = Math.max(0, Math.min(16, options.reserve ?? 0));
        const wanted = Math.min(options.colors ?? mode.colors, 16) - reserve;

        const current = this.screen.palette;
        const chosen = choosePalette(source, wanted, options.alphaThreshold ?? 128);
        return Array.from({ length: 16 }, (_, i) =>
            i >= reserve && i - reserve < chosen.length ? chosen[i - reserve] : [...current[i]] as PaletteColor);
    }

    /** The same, for a picture that has still to be fetched. */
    async loadPalette(url: string, options: PaletteOptions = {}): Promise<PaletteColor[]> {
        return this.palette(await this.decode(url), options);
    }

    /** Queues a loaded picture for the blitter, which lays it down at the chip's pace. */
    draw(image: IndexedImage, x = 0, y = 0, options: DrawOptions = {}): void {
        this.gfx.drawImage(x, y, image.width, image.height, image.pixels, !!options.transparent);
    }

    /** The same, written straight into VRAM. A backdrop should not arrive in instalments. */
    drawNow(image: IndexedImage, x = 0, y = 0, options: DrawOptions = {}): void {
        this.gfx.now.drawImage(x, y, image.width, image.height, image.pixels, !!options.transparent);
    }

    /**
     * Fetch, reduce, centre and show - the whole way from a URL to the screen
     * for a picture meant to fill it. Defaults to fitting the screen whole;
     * pass `fit: "cover"` to fill it and lose the overflow instead.
     */
    async show(url: string, options: ReduceOptions & DrawOptions = {}): Promise<IndexedImage> {
        const image = await this.load(url, { width: this.screen.width, height: this.screen.height, ...options });
        this.drawNow(image,
            (this.screen.width - image.width) >> 1,
            (this.screen.height - image.height) >> 1,
            options);
        return image;
    }

    private modeFor(options: { mode?: ScreenModeName }): ScreenMode {
        const mode = options.mode ? MODES[options.mode] : this.screen.mode;
        if (!mode.bitmap) {
            throw new Error(`${mode.name} has no framebuffer to put a picture in - use G4, G5, G6 or G7`);
        }
        return mode;
    }
}

// --- Decoding -------------------------------------------------------------

/**
 * The browser's own decoder, by way of a canvas. Anything the page could show
 * in an <img> works, `data:` URLs included.
 */
async function decodeWithBrowser(url: string): Promise<RgbaImage> {
    if (typeof createImageBitmap !== "function" || typeof fetch !== "function") {
        throw new Error("no image decoder in this environment - set bios.image.decoder");
    }

    const response = await fetch(url);
    if (!response.ok) throw new Error(`could not fetch ${url}: ${response.status} ${response.statusText}`);

    const bitmap = await createImageBitmap(await response.blob());
    try {
        const canvas = createCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | null;
        if (!context) throw new Error("could not get a 2d context to decode into");
        context.drawImage(bitmap as unknown as CanvasImageSource, 0, 0);
        return context.getImageData(0, 0, bitmap.width, bitmap.height);
    } finally {
        bitmap.close?.();
    }
}

function createCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
    if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(width, height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
}

// --- Geometry -------------------------------------------------------------

interface SourceRect { x: number; y: number; width: number; height: number; }

/**
 * Works out what part of the source is used and how big it comes out, in
 * pixels of the target mode.
 *
 * The 512-wide modes make this less obvious than it looks: their pixels are
 * half as wide as they are tall, so a picture scaled to fill 512 of them is
 * only as wide as 256 of GRAPHIC4's. `aspect` does that arithmetic in the
 * screen's real proportions and hands back a pixel count.
 */
function fitSize(source: RgbaImage, mode: ScreenMode, options: ReduceOptions): { rect: SourceRect; width: number; height: number } {
    const whole: SourceRect = { x: 0, y: 0, width: source.width, height: source.height };
    // How wide one of this mode's pixels is against its height.
    const pixelAspect = options.aspect === false ? 1 : 256 / mode.width;

    // No target at all: keep the art as it was drawn unless it will not fit.
    if (options.width === undefined && options.height === undefined) {
        if (source.width <= mode.width && source.height <= mode.height) {
            return { rect: whole, width: source.width, height: source.height };
        }
        options = { ...options, width: mode.width, height: mode.height, fit: options.fit ?? "contain" };
    }

    // Only one side given: the other follows the source's proportions.
    if (options.width === undefined) {
        const height = clampSize(options.height!, mode.height);
        return { rect: whole, width: clampSize((source.width / source.height) * height / pixelAspect, mode.width), height };
    }
    if (options.height === undefined) {
        const width = clampSize(options.width, mode.width);
        return { rect: whole, width, height: clampSize((source.height / source.width) * width * pixelAspect, mode.height) };
    }

    const width = clampSize(options.width, mode.width);
    const height = clampSize(options.height, mode.height);
    if ((options.fit ?? "contain") === "stretch") return { rect: whole, width, height };

    // Compare shapes in real proportions: the target box is `width * pixelAspect` wide.
    const targetShape = (width * pixelAspect) / height;
    const sourceShape = source.width / source.height;

    if ((options.fit ?? "contain") === "contain") {
        return sourceShape > targetShape
            ? { rect: whole, width, height: clampSize(width * pixelAspect / sourceShape, height) }
            : { rect: whole, width: clampSize(height * sourceShape / pixelAspect, width), height };
    }

    // cover: fill the box and crop the middle of whichever axis is too long.
    if (sourceShape > targetShape) {
        const cropped = source.height * targetShape;
        return { rect: { x: (source.width - cropped) / 2, y: 0, width: cropped, height: source.height }, width, height };
    }
    const cropped = source.width / targetShape;
    return { rect: { x: 0, y: (source.height - cropped) / 2, width: source.width, height: cropped }, width, height };
}

function clampSize(value: number, limit: number): number {
    return Math.max(1, Math.min(limit, Math.round(value)));
}

/**
 * Box filter. Every destination pixel averages the source pixels it covers,
 * which is what keeps a photograph from breaking up on the way down; scaling
 * up, the box lands inside one source pixel and this degenerates to nearest
 * neighbour, which is what pixel art wants.
 *
 * Colours are averaged with alpha premultiplied, so a transparent border does
 * not bleed its colour into the edge.
 */
function resample(source: RgbaImage, rect: SourceRect, width: number, height: number): Uint8ClampedArray {
    const out = new Uint8ClampedArray(width * height * 4);
    const scaleX = rect.width / width;
    const scaleY = rect.height / height;

    for (let y = 0; y < height; ++y) {
        const top = rect.y + y * scaleY;
        const y0 = Math.max(0, Math.floor(top));
        const y1 = Math.min(source.height, Math.max(y0 + 1, Math.ceil(top + scaleY)));

        for (let x = 0; x < width; ++x) {
            const left = rect.x + x * scaleX;
            const x0 = Math.max(0, Math.floor(left));
            const x1 = Math.min(source.width, Math.max(x0 + 1, Math.ceil(left + scaleX)));

            let r = 0, g = 0, b = 0, a = 0, n = 0;
            for (let sy = y0; sy < y1; ++sy) {
                let p = (sy * source.width + x0) * 4;
                for (let sx = x0; sx < x1; ++sx, p += 4) {
                    const alpha = source.data[p + 3] / 255;
                    r += source.data[p] * alpha;
                    g += source.data[p + 1] * alpha;
                    b += source.data[p + 2] * alpha;
                    a += source.data[p + 3];
                    ++n;
                }
            }

            const q = (y * width + x) * 4;
            const opacity = a / (n * 255) || 0;
            // Undo the premultiplication, or everything half-transparent darkens.
            out[q] = opacity ? r / n / opacity : 0;
            out[q + 1] = opacity ? g / n / opacity : 0;
            out[q + 2] = opacity ? b / n / opacity : 0;
            out[q + 3] = a / n;
        }
    }
    return out;
}

// --- Reduction ------------------------------------------------------------

/**
 * The set of colours a mode can put in one pixel, and the search for the
 * nearest of them. GRAPHIC7 is the odd one: 256 colours arranged so regularly
 * that the nearest is computed rather than looked for.
 */
interface Target {
    /** How far apart neighbouring colours sit, per channel - the amplitude a dither needs. */
    readonly steps: readonly [number, number, number];
    nearest(r: number, g: number, b: number): number;
    rgb(index: number): readonly [number, number, number];
}

function buildTarget(mode: ScreenMode, palette: ReadonlyArray<PaletteColor>, exclude: readonly number[] = []): Target {
    if (mode.colors === 256) return fixedTarget();

    const banned = new Set(exclude);
    const entries: Array<{ index: number; rgb: [number, number, number] }> = [];
    for (let i = 0; i < mode.colors; ++i) {
        if (!banned.has(i)) entries.push({ index: i, rgb: paletteRgb(palette[i] ?? [0, 0, 0]) });
    }
    if (entries.length === 0) throw new Error("every colour of the mode was excluded - nothing to reduce to");

    return paletteTarget(entries);
}

/** GRAPHIC7: green and red are a 3-bit ramp, blue only 2 bits, and none of it is a palette. */
function fixedTarget(): Target {
    return {
        steps: [255 / 7, 255 / 7, 255 / 3],
        nearest: rgbToColor256,
        rgb: color256Rgb
    };
}

function paletteTarget(entries: Array<{ index: number; rgb: [number, number, number] }>): Target {
    // A 15-bit cache: dithering keeps handing over colours that are near each
    // other, and the search costs far more than the lookup.
    const cache = new Int16Array(1 << 15).fill(-1);
    const byIndex: Array<readonly [number, number, number]> = [];
    for (const entry of entries) byIndex[entry.index] = entry.rgb;

    const nearest = (r: number, g: number, b: number): number => {
        const red = clamp255(r), green = clamp255(g), blue = clamp255(b);
        const key = ((red >> 3) << 10) | ((green >> 3) << 5) | (blue >> 3);
        const cached = cache[key];
        if (cached >= 0) return cached;

        let best = entries[0].index;
        let distance = Infinity;
        for (const entry of entries) {
            const dr = red - entry.rgb[0];
            const dg = green - entry.rgb[1];
            const db = blue - entry.rgb[2];
            const d = WEIGHT_R * dr * dr + WEIGHT_G * dg * dg + WEIGHT_B * db * db;
            if (d < distance) { distance = d; best = entry.index; }
        }
        cache[key] = best;
        return best;
    };

    // How far a dither may push a pixel: about half the gap between a colour
    // and its closest neighbour, averaged over the palette. A palette of near
    // duplicates gets a gentle dither, a sparse one a strong one.
    let spread = 0;
    for (const entry of entries) {
        let closest = Infinity;
        for (const other of entries) {
            if (other === entry) continue;
            const dr = entry.rgb[0] - other.rgb[0];
            const dg = entry.rgb[1] - other.rgb[1];
            const db = entry.rgb[2] - other.rgb[2];
            closest = Math.min(closest, Math.sqrt(dr * dr + dg * dg + db * db));
        }
        if (Number.isFinite(closest)) spread += closest;
    }
    const step = entries.length > 1 ? spread / entries.length : 0;

    return { steps: [step, step, step], nearest, rgb: (i) => byIndex[i] ?? [0, 0, 0] };
}

function quantize(rgba: Uint8ClampedArray, width: number, height: number, target: Target, options: ReduceOptions): Uint8Array {
    const pixels = new Uint8Array(width * height);
    const threshold = options.alphaThreshold ?? 128;
    const transparent = options.transparentIndex ?? 0;
    const amount = options.ditherAmount ?? 1;
    const dither = options.dither ?? "floyd-steinberg";

    if (dither === "floyd-steinberg" && amount > 0) {
        diffuse(rgba, width, height, target, pixels, threshold, transparent, amount);
        return pixels;
    }

    const bias = dither === "ordered" ? amount : 0;
    for (let y = 0; y < height; ++y) {
        for (let x = 0; x < width; ++x) {
            const p = (y * width + x) * 4;
            if (rgba[p + 3] < threshold) { pixels[y * width + x] = transparent; continue; }

            // Bayer nudges each pixel up or down by up to half a step, in a
            // pattern that repeats every 4 pixels and never moves.
            const offset = bias ? (BAYER[(y & 3) * 4 + (x & 3)] / 16 - 0.46875) * bias : 0;
            pixels[y * width + x] = target.nearest(
                rgba[p] + offset * target.steps[0],
                rgba[p + 1] + offset * target.steps[1],
                rgba[p + 2] + offset * target.steps[2]
            );
        }
    }
    return pixels;
}

/**
 * Floyd-Steinberg, walked in a serpentine so the error does not all drift the
 * same way and leave a diagonal grain across the picture.
 */
function diffuse(
    rgba: Uint8ClampedArray, width: number, height: number, target: Target,
    pixels: Uint8Array, threshold: number, transparent: number, amount: number
): void {
    // Two rows of carried error is all the kernel ever reaches.
    let current = new Float32Array(width * 3);
    let next = new Float32Array(width * 3);

    for (let y = 0; y < height; ++y) {
        const rightwards = (y & 1) === 0;
        for (let i = 0; i < width; ++i) {
            const x = rightwards ? i : width - 1 - i;
            const p = (y * width + x) * 4;
            const e = x * 3;

            if (rgba[p + 3] < threshold) { pixels[y * width + x] = transparent; continue; }

            const r = rgba[p] + current[e];
            const g = rgba[p + 1] + current[e + 1];
            const b = rgba[p + 2] + current[e + 2];

            const index = target.nearest(r, g, b);
            pixels[y * width + x] = index;

            const got = target.rgb(index);
            const dr = (r - got[0]) * amount;
            const dg = (g - got[1]) * amount;
            const db = (b - got[2]) * amount;

            const ahead = rightwards ? x + 1 : x - 1;
            const behind = rightwards ? x - 1 : x + 1;
            spread(current, ahead, width, dr, dg, db, 7 / 16);
            spread(next, behind, width, dr, dg, db, 3 / 16);
            spread(next, x, width, dr, dg, db, 5 / 16);
            spread(next, ahead, width, dr, dg, db, 1 / 16);
        }

        const spent = current;
        current = next;
        next = spent;
        next.fill(0);
    }
}

function spread(row: Float32Array, x: number, width: number, r: number, g: number, b: number, weight: number): void {
    if (x < 0 || x >= width) return;
    row[x * 3] += r * weight;
    row[x * 3 + 1] += g * weight;
    row[x * 3 + 2] += b * weight;
}

function clamp255(value: number): number {
    return value < 0 ? 0 : value > 255 ? 255 : value | 0;
}

// --- Palette generation ---------------------------------------------------

/** Bits per channel of the histogram the search runs over. 5 gives 32768 cells. */
const HISTOGRAM_BITS = 5;
const HISTOGRAM_SIZE = 1 << (HISTOGRAM_BITS * 3);

/** How many times the centres are pulled back onto their clusters. */
const REFINEMENTS = 8;

/** Colours that occur, collapsed onto the histogram grid and counted. */
interface Samples {
    /** Occupied cells, as offsets into the sums below. */
    readonly cells: Int32Array;
    /** Average colour of each cell, and how many pixels landed in it. */
    readonly r: Float64Array;
    readonly g: Float64Array;
    readonly b: Float64Array;
    readonly weight: Float64Array;
}

/**
 * Picks the colours a picture is mostly made of.
 *
 * Median cut lays out the first guess - split the box with the longest side at
 * the median of that side, until there are as many boxes as colours - and then
 * a few rounds of k-means pull each colour onto the middle of the pixels that
 * actually chose it. Median cut alone is happy to put one entry across two
 * clusters that share an axis; the refinement is what stops that.
 *
 * It all runs over a 5-bit histogram rather than the pixels, so the cost
 * follows how many distinct colours the picture has, not how big it is.
 */
function choosePalette(source: RgbaImage, count: number, alphaThreshold: number): PaletteColor[] {
    if (count <= 0) return [];

    const samples = histogram(source, alphaThreshold);
    if (samples.cells.length === 0) return [[0, 0, 0]];

    const boxes = split(samples, Math.min(count, samples.cells.length)).filter((box) => box.to > box.from);
    const centers = refine(samples, boxes.map((box) => centroid(samples, box.from, box.to)));

    // Two centres can round onto the same 3-bit colour; a duplicate entry is a
    // wasted register, so drop it and let the caller keep what was there.
    const palette: PaletteColor[] = [];
    for (const center of centers) {
        const color = rgbToPalette(center[0], center[1], center[2]);
        if (!palette.some((c) => c[0] === color[0] && c[1] === color[1] && c[2] === color[2])) palette.push(color);
    }
    return palette;
}

function histogram(source: RgbaImage, alphaThreshold: number): Samples {
    const shift = 8 - HISTOGRAM_BITS;
    const weight = new Float64Array(HISTOGRAM_SIZE);
    const r = new Float64Array(HISTOGRAM_SIZE);
    const g = new Float64Array(HISTOGRAM_SIZE);
    const b = new Float64Array(HISTOGRAM_SIZE);

    const total = source.width * source.height;
    for (let i = 0; i < total; ++i) {
        const p = i * 4;
        if (source.data[p + 3] < alphaThreshold) continue;
        const cell = ((source.data[p] >> shift) << (HISTOGRAM_BITS * 2))
            | ((source.data[p + 1] >> shift) << HISTOGRAM_BITS)
            | (source.data[p + 2] >> shift);
        weight[cell] += 1;
        r[cell] += source.data[p];
        g[cell] += source.data[p + 1];
        b[cell] += source.data[p + 2];
    }

    const cells: number[] = [];
    for (let cell = 0; cell < HISTOGRAM_SIZE; ++cell) {
        if (weight[cell] === 0) continue;
        r[cell] /= weight[cell];
        g[cell] /= weight[cell];
        b[cell] /= weight[cell];
        cells.push(cell);
    }
    return { cells: Int32Array.from(cells), r, g, b, weight };
}

interface Box {
    /** The run of `cells` this box owns. */
    from: number;
    to: number;
    /** Longest side of the colour cube it spans, weighted the way colours are compared. */
    length: number;
    /** 0 red, 1 green, 2 blue. */
    channel: number;
}

/** Median cut, over cells rather than pixels, splitting on pixel count. */
function split(samples: Samples, count: number): Box[] {
    const boxes: Box[] = [measure(samples, 0, samples.cells.length)];

    while (boxes.length < count) {
        let widest = 0;
        for (let i = 1; i < boxes.length; ++i) if (boxes[i].length > boxes[widest].length) widest = i;

        const box = boxes[widest];
        if (box.length === 0 || box.to - box.from < 2) break;      // nothing left worth splitting

        const axis = channelOf(samples, box.channel);
        const run = Array.from(samples.cells.subarray(box.from, box.to)).sort((a, b) => axis[a] - axis[b]);
        samples.cells.set(run, box.from);

        // Cut where half the box's pixels lie, not half its cells: a wide
        // scattering of near-empty colours must not outvote a solid mass.
        let half = 0;
        for (const cell of run) half += samples.weight[cell];
        half /= 2;

        // Both sides must come out with something in them, so the cut can
        // land anywhere from just after the first cell to just before the last.
        let at = box.from;
        let carried = 0;
        while (at < box.to - 1) {
            carried += samples.weight[samples.cells[at]];
            ++at;
            if (carried >= half) break;
        }

        boxes[widest] = measure(samples, box.from, at);
        boxes.push(measure(samples, at, box.to));
    }
    return boxes;
}

/** The extent of a run of cells, and which channel it is longest in. */
function measure(samples: Samples, from: number, to: number): Box {
    const channels = [samples.r, samples.g, samples.b];
    const weights = [WEIGHT_R, WEIGHT_G, WEIGHT_B];
    let channel = 0;
    let length = -1;

    for (let c = 0; c < 3; ++c) {
        let low = 255;
        let high = 0;
        for (let i = from; i < to; ++i) {
            const value = channels[c][samples.cells[i]];
            if (value < low) low = value;
            if (value > high) high = value;
        }
        const extent = (high - low) * weights[c];
        if (extent > length) { length = extent; channel = c; }
    }
    return { from, to, length: Math.max(0, length), channel };
}

function channelOf(samples: Samples, channel: number): Float64Array {
    return channel === 0 ? samples.r : channel === 1 ? samples.g : samples.b;
}

function centroid(samples: Samples, from: number, to: number): [number, number, number] {
    let r = 0, g = 0, b = 0, total = 0;
    for (let i = from; i < to; ++i) {
        const cell = samples.cells[i];
        const w = samples.weight[cell];
        r += samples.r[cell] * w;
        g += samples.g[cell] * w;
        b += samples.b[cell] * w;
        total += w;
    }
    return total ? [r / total, g / total, b / total] : [0, 0, 0];
}

/**
 * K-means, weighted by how many pixels each cell stands for. A handful of
 * rounds is enough - the boxes already put the centres in roughly the right
 * places, and this only has to finish the job.
 */
function refine(samples: Samples, centers: Array<[number, number, number]>): Array<[number, number, number]> {
    const sums = new Float64Array(centers.length * 4);

    for (let round = 0; round < REFINEMENTS; ++round) {
        sums.fill(0);

        for (const cell of samples.cells) {
            let best = 0;
            let distance = Infinity;
            for (let c = 0; c < centers.length; ++c) {
                const dr = samples.r[cell] - centers[c][0];
                const dg = samples.g[cell] - centers[c][1];
                const db = samples.b[cell] - centers[c][2];
                const d = WEIGHT_R * dr * dr + WEIGHT_G * dg * dg + WEIGHT_B * db * db;
                if (d < distance) { distance = d; best = c; }
            }
            const w = samples.weight[cell];
            sums[best * 4] += samples.r[cell] * w;
            sums[best * 4 + 1] += samples.g[cell] * w;
            sums[best * 4 + 2] += samples.b[cell] * w;
            sums[best * 4 + 3] += w;
        }

        let moved = 0;
        for (let c = 0; c < centers.length; ++c) {
            const total = sums[c * 4 + 3];
            if (total === 0) continue;                      // a centre nothing chose stays put
            const next: [number, number, number] = [sums[c * 4] / total, sums[c * 4 + 1] / total, sums[c * 4 + 2] / total];
            moved = Math.max(moved, Math.abs(next[0] - centers[c][0]), Math.abs(next[1] - centers[c][1]), Math.abs(next[2] - centers[c][2]));
            centers[c] = next;
        }
        if (moved < 0.5) break;                             // settled to within a level of the ramp
    }
    return centers;
}
