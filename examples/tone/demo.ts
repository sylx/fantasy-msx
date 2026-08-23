// TONE - the same picture, in every bitmap mode the V9938 has.
//
// A photograph is 24 bits a pixel. A V9938 framebuffer is four, or two, or
// eight - and only in the eight-bit one is the number a colour rather than an
// index into sixteen registers. So a picture reaching this machine has to lose
// almost everything it has, and *which* of it it loses is the interesting part.
//
// Left and right walk through the four modes, so the same source lands in each
// of them one after another:
//
//   SCREEN 5  256x212, 16 colours out of 512    the workhorse
//   SCREEN 6  512x212, 4 colours out of 512     twice the pixels, a quarter of the palette
//   SCREEN 7  512x212, 16 colours out of 512    both, and half the VRAM gone
//   SCREEN 8  256x212, 256 fixed colours        no palette at all: GRB 3-3-2
//
// The picture is fetched and decoded once. Everything after that is
// `image.reduce`, which is why switching modes is a job for one frame rather
// than another round trip to the network.
//
// It arrives through the blitter, so you watch it land at the rate the chip
// would actually push pixels in from outside: about 120 VDP cycles a pixel,
// which is a dozen frames for a SCREEN 5 screenful and nearer thirty for
// SCREEN 7. The bar along the bottom is `gfx.work`, the queue draining.

import {
    BUTTON, compile, opllVoice, paletteRgb, psgVoice,
    type App, type Context, type Dither, type RgbaImage, type ScreenModeName
} from "../../src/index.js";

/** Vite rewrites this to the built asset's URL, and serves it as it is in dev. */
const PHOTO = new URL("./dusk.png", import.meta.url).href;

// --- What we can switch between ----------------------------------------------

interface Mode {
    readonly name: ScreenModeName;
    /** The MSX-BASIC number, which is what anyone who used one remembers. */
    readonly screen: number;
}

const MODES: readonly Mode[] = [
    { name: "G4", screen: 5 },
    { name: "G5", screen: 6 },
    { name: "G6", screen: 7 },
    { name: "G7", screen: 8 }
];

const DITHERS: ReadonlyArray<{ name: Dither; label: string }> = [
    { name: "floyd-steinberg", label: "FLOYD-STEINBERG" },
    { name: "ordered", label: "ORDERED 4X4" },
    { name: "none", label: "NEAREST" }
];

/** Lines kept clear at the bottom for the readout and the queue bar. */
const STATUS_HEIGHT = 20;

/**
 * Palette entries held back for the readout: 0 for its paper, 1 for its ink.
 * The picture gets fourteen instead of sixteen, which is the price of having
 * anything legible over the top of it - and what `reserve` is for.
 */
const RESERVED = 2;

// --- The second picture, which never touches the network ---------------------

/**
 * A chart rather than a photograph: hue across, brightness down the top half
 * and saturation down the bottom, then a grey ramp and eight flat patches.
 *
 * It goes through `image.reduce` instead of `image.load` - the reduction takes
 * decoded pixels, and where they came from is not its business. What it is
 * good for is seeing the shape of a mode's reach: which hues SCREEN 8 can hold
 * and SCREEN 5 cannot, and how few of them are left by SCREEN 6.
 */
function chart(width: number, height: number): RgbaImage {
    const data = new Uint8ClampedArray(width * height * 4);
    const hueBand = height * 0.42;
    const satBand = height * 0.72;

    for (let y = 0; y < height; ++y) {
        for (let x = 0; x < width; ++x) {
            const u = x / width;
            const color = y < hueBand ? hsv(u, 1, 1 - (y / hueBand) * 0.92)
                : y < satBand ? hsv(u, (y - hueBand) / (satBand - hueBand), 1)
                : (y - satBand) / (height - satBand) < 0.5
                    ? [u * 255, u * 255, u * 255]
                    : hsv(Math.floor(u * 8) / 8, 1, 1);
            data.set([color[0], color[1], color[2], 255], (y * width + x) * 4);
        }
    }
    return { width, height, data };
}

function hsv(h: number, s: number, v: number): [number, number, number] {
    const sector = Math.floor(h * 6) % 6;
    const f = h * 6 - Math.floor(h * 6);
    const [p, q, t] = [v * (1 - s), v * (1 - s * f), v * (1 - s * (1 - f))];
    const wheel: Array<[number, number, number]> = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]];
    return wheel[sector].map((c) => c * 255) as [number, number, number];
}

// --- Music -------------------------------------------------------------------

const SCORE = compile([
    { voice: opllVoice(0), mml: "t92 @15 v11 l1 o3 [f c a- e-]2" },
    { voice: opllVoice(1), mml: "t92 @15 v9  l1 o4 [c g e- b-]2" },
    { voice: opllVoice(2), mml: "t92 @14 v8  l2 o4 [a- g f e- d- c e- f]2" },
    { voice: psgVoice(0),  mml: "t92 v10 q7 l2 o2 [ff cc a-a- e-e-]2" }
]);

// --- State -------------------------------------------------------------------

interface Picture {
    readonly title: string;
    /** Where it came from, for the readout. */
    readonly origin: string;
    /** Full colour, decoded once and kept for every reduction after. */
    pixels: RgbaImage | null;
}

let pictures: Picture[] = [];
let picture = 0;
let mode = 0;
let dither = 0;
/** Whether the palette is chosen for the picture or left as the machine booted. */
let ownPalette = true;
/** Set whenever something changed and the picture has to be reduced again. */
let dirty = true;
/** What the last reduction cost, in milliseconds. */
let cost = 0;
let failure: string | null = null;
/** The readout's two colours, settled whenever the palette changes under it. */
let ink = 15;
let paper = 0;

// --- Drawing -----------------------------------------------------------------

/**
 * Loads the palette the reduction is about to run against, and settles the two
 * colours the readout will use over it.
 *
 * SCREEN 6 has four colours, which is too few to give two away, so there the
 * readout takes the darkest and brightest of whatever the picture chose. The
 * sixteen-colour modes can afford to reserve a pair.
 */
function preparePalette(ctx: Context, source: RgbaImage): void {
    const { screen, image } = ctx;

    if (screen.mode.colors === 256) return extremes(ctx);   // nothing to load
    if (!ownPalette) {
        screen.resetPalette();
        return extremes(ctx);
    }

    const reserve = screen.mode.colors >= 16 ? RESERVED : 0;
    if (reserve) {
        // Reserved entries are read back as they stand, so they have to be
        // what we want before the palette is chosen around them.
        screen.setColor(0, 0, 0, 0);
        screen.setColor(1, 7, 7, 7);
    }
    screen.setPalette(image.palette(source, { reserve }));

    if (reserve) { paper = 0; ink = 1; } else extremes(ctx);
}

/**
 * The darkest entry of the palette and the brightest, for reading text over.
 * SCREEN 8 has no palette, and there black and white are simply two of its 256.
 */
function extremes(ctx: Context): void {
    if (ctx.screen.mode.colors === 256) {
        ink = 0xff;
        paper = 0x00;
        return;
    }

    let brightest = -1;
    let darkest = Infinity;
    for (let i = 0; i < ctx.screen.mode.colors; ++i) {
        const [r, g, b] = paletteRgb(ctx.screen.palette[i]);
        const luma = r * 2 + g * 4 + b;
        if (luma > brightest) { brightest = luma; ink = i; }
        if (luma < darkest) { darkest = luma; paper = i; }
    }
}

/**
 * Reduces the picture for the mode now selected and hands it to the blitter.
 * Everything the readout needs is settled here too, since it must be legible
 * against whatever palette the reduction just decided on.
 */
function rebuild(ctx: Context): void {
    const { screen, gfx, image } = ctx;
    const source = pictures[picture].pixels;

    gfx.abandon();                                  // drop whatever the last mode left queued
    screen.setMode(MODES[mode].name);

    if (!source) {
        screen.resetPalette();
        extremes(ctx);
        gfx.now.clear(paper);
        gfx.now.text(8, 8, failure ?? "LOADING...", ink);
        return;
    }

    // The palette is an input to the reduction, so it has to be in the
    // registers before the reduction is asked for.
    preparePalette(ctx, source);

    const started = performance.now();
    const reduced = image.reduce(source, {
        width: screen.width,
        height: screen.height - STATUS_HEIGHT,
        dither: DITHERS[dither].name
    });
    cost = performance.now() - started;

    gfx.now.clear(paper);
    readout(ctx, reduced.width, reduced.height);

    // Queued rather than written: the point is to watch it arrive.
    image.draw(reduced,
        (screen.width - reduced.width) >> 1,
        (screen.height - STATUS_HEIGHT - reduced.height) >> 1);
}

function readout(ctx: Context, width: number, height: number): void {
    const { screen, gfx } = ctx;
    const top = screen.height - STATUS_HEIGHT + 2;
    const colors = screen.mode.colors === 256 ? "256 FIXED" : `${screen.mode.colors} OF 512`;

    gfx.now.text(4, top,
        `${pictures[picture].title} ${pictures[picture].origin}  SCREEN ${MODES[mode].screen}  ${width}X${height}  ${colors}`,
        ink, paper);
    gfx.now.text(4, top + 8,
        `${DITHERS[dither].label}  ${screen.mode.colors === 256 ? "NO PALETTE" : ownPalette ? "OWN PALETTE" : "BOOT PALETTE"}  ${Math.round(cost)}MS`,
        ink, paper);
}

// --- The app -----------------------------------------------------------------

export const demo: App = {
    init(ctx) {
        pictures = [
            { title: "DUSK", origin: "PNG", pixels: null },
            { title: "CHART", origin: "CODE", pixels: chart(512, 424) }
        ];
        picture = 0;
        mode = 0;
        dither = 0;
        ownPalette = true;
        dirty = true;
        failure = null;

        // The one round trip. Everything after it is arithmetic.
        void ctx.image.decode(PHOTO).then(
            (decoded) => { pictures[0].pixels = decoded; dirty = true; },
            (error) => { failure = String(error?.message ?? error).toUpperCase().slice(0, 34); dirty = true; }
        );

        ctx.bgm.play(SCORE, { loop: true });
        ctx.sprites.setEnabled(false);
    },

    update(ctx) {
        const { input } = ctx;

        if (input.btnp(BUTTON.RIGHT)) { mode = (mode + 1) % MODES.length; dirty = true; }
        if (input.btnp(BUTTON.LEFT)) { mode = (mode + MODES.length - 1) % MODES.length; dirty = true; }
        if (input.btnp(BUTTON.DOWN)) { dither = (dither + 1) % DITHERS.length; dirty = true; }
        if (input.btnp(BUTTON.UP)) { dither = (dither + DITHERS.length - 1) % DITHERS.length; dirty = true; }
        if (input.btnp(BUTTON.A)) { ownPalette = !ownPalette; dirty = true; }
        if (input.btnp(BUTTON.B)) { picture = (picture + 1) % pictures.length; dirty = true; }
    },

    draw(ctx) {
        if (dirty) {
            dirty = false;
            rebuild(ctx);
        }

        // The queue draining, along the last two lines of the screen.
        const total = ctx.screen.width * (ctx.screen.height - STATUS_HEIGHT);
        const left = Math.min(total, ctx.gfx.work);
        const bar = Math.round((left / total) * ctx.screen.width);
        ctx.gfx.now.fillRect(0, ctx.screen.height - 2, ctx.screen.width, 2, paper);
        if (bar > 0) ctx.gfx.now.fillRect(0, ctx.screen.height - 2, bar, 2, ink);
    }
};
