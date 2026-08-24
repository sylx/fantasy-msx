// TYPE - a specimen sheet, set in the host's fonts.
//
// The machine's own font is 5 pixels wide inside an 8x8 cell, ASCII 32 to 126,
// and it is the whole typographic resource a real MSX had. This demo sets the
// same words in the browser's fonts instead: laid out and rasterised outside
// the machine, spent on a ramp of palette entries, and carried into VRAM one
// byte per pixel like any other picture. The strip near the bottom is the ROM font saying the same
// thing, which is the comparison the demo exists for - and on the Japanese
// sample it says `??????????`, because those glyphs were never in the ROM.
//
// The knob worth playing with is the ramp. What arrives from the host is
// coverage - how much of each pixel the glyphs cover, 0 to 255 - and the
// machine has no such quantity, so the coverage has to be spent on indices
// that already exist. Up and down walk from a solid edge to a four-entry ramp,
// and the swatches in the readout are the registers each one costs: the
// smoothing is not free, it is taken out of the sixteen colours everything
// else on screen is also drawing from. The demo can afford three because a
// specimen sheet has nothing else in it; a game with artwork usually cannot.
//
// Which is also why the ramp is written out here rather than worked out by the
// machine. `text` never picks a colour or repaints a register - the four greys
// between this sheet's paper and its ink are set by the demo, in the palette,
// before a word is set.
//
// Z switches between SCREEN 5 and SCREEN 7 - the same sheet, and twice the
// pixels across it. A SCREEN 7 pixel is half as wide as it is tall, so type set
// the way SCREEN 5 sets it would come out condensed to half its width; `text`
// draws the em twice as wide instead, and the line keeps its shape and spends
// the extra columns on detail. It is the one thing this machine can do for
// small type that no ramp can: the sheet at the foot of the page, in the ROM
// font, is condensed exactly as an MSX's own SCREEN 7 text was.
//
// Nothing here is fetched. The faces are the CSS generic families, so whatever
// the machine running the page calls its serif is what gets set.
//
// The display line is queued rather than written, so you watch it lay down at
// the rate the V9938 would push pixels in from outside. Everything under it is
// `drawNow`: a specimen sheet that arrived in instalments would be unreadable
// while it did.

import {
    BUTTON, compile, opllVoice, psgVoice,
    type App, type Context, type ScreenModeName, type TextStyle, type Typesetter
} from "../../src/index.js";

// --- The sheet ---------------------------------------------------------------

const MARGIN = 8;
/** Lines kept clear at the bottom for the readout and the queue bar. */
const STATUS_HEIGHT = 18;

/** Sizes the display line is tried at, largest first, until one fits the measure. */
const DISPLAY_SIZES = [40, 34, 28, 24, 20, 16];
/** The same, for the line under the rule, which is set across the measure too. */
const SUBHEAD_SIZES = [16, 14, 13, 12, 11, 10, 9];
const BODY_SIZE = 10;
const BODY_LEADING = 12;

/** The entries the sheet is set in. The rest of the palette is left as it booted. */
const PAPER = 0;
const INK = 1;
const RULE = 2;
const ACCENT = 3;
/** Three greys stepped from the paper down to the ink, for the ramps to draw on. */
const PALE = 4;
const MID = 5;
const DEEP = 6;

/**
 * What the coverage may be spent on, palest entry first. `SOLID` is a ramp of
 * one - the hard edge the machine's own font has - and every entry after that
 * is a palette register the type has taken off everything else on screen.
 */
const RAMPS: ReadonlyArray<{ label: string; shades: readonly number[] }> = [
    { label: "SOLID", shades: [INK] },
    { label: "2 SHADES", shades: [MID, INK] },
    { label: "3 SHADES", shades: [PALE, MID, INK] },
    { label: "4 SHADES", shades: [PALE, MID, DEEP, INK] }
];

// --- What we can switch between ----------------------------------------------

/**
 * The CSS generic families, with a weight and an italic among them. Naming a
 * face outright would mean shipping it or fetching it; these are whatever the
 * host has already decided they are, which is also the honest demonstration -
 * the machine is borrowing the page's fonts.
 */
const FACES: ReadonlyArray<{ label: string; style: TextStyle }> = [
    { label: "SANS-SERIF", style: { font: "sans-serif" } },
    { label: "SANS-SERIF BOLD", style: { font: "sans-serif", weight: 700 } },
    { label: "SERIF", style: { font: "serif" } },
    { label: "SERIF ITALIC", style: { font: "serif", italic: true } },
    { label: "MONOSPACE", style: { font: "monospace" } },
    { label: "CURSIVE", style: { font: "cursive" } },
    { label: "SYSTEM-UI", style: { font: "system-ui" } }
];

/**
 * The two modes worth setting type in. Both give sixteen colours; SCREEN 7
 * gives twice the pixels across the same picture, so its pixels are half as
 * wide as they are tall - which `text` corrects for, drawing the em twice as
 * wide so that a line keeps its shape and gains the detail instead.
 */
const MODES: ReadonlyArray<{ name: ScreenModeName; screen: number }> = [
    { name: "G4", screen: 5 },
    { name: "G6", screen: 7 }
];

interface Sample {
    readonly display: string;
    readonly line: string;
    readonly body: string;
}

const SAMPLES: readonly Sample[] = [
    {
        display: "Hamburgefonstiv",
        line: "The quick brown fox jumps over the lazy dog",
        body: "Ten pixels to the em, and four bits to the pixel. What reaches the screen "
            + "is coverage spent on a ramp of palette entries, so the shape of a letter here "
            + "is decided as much by that budget as by the punchcutter."
    },
    {
        display: "タイポグラフィ",
        line: "いろはにほへと ちりぬるを わかよたれそ",
        body: "内蔵フォントは ASCII しか持っていない。ホスト側の canvas で組んだ文字を "
            + "そのまま VRAM に運ぶので、漢字もかなも一枚の絵として画面に置ける。"
    },
    {
        display: "V9938 / 1985",
        line: "256 x 212, sixteen colours out of five hundred and twelve",
        body: "A real MSX2 had one font and no way to measure it. This one asks the browser "
            + "where the baseline is, how wide the line came out, and how much of each pixel "
            + "the glyphs covered - and then buys back a little of it, three registers at a time."
    }
];

// --- Music -------------------------------------------------------------------

const SCORE = compile([
    { voice: opllVoice(0), mml: "t84 @14 v9 l1 o3 [c a- f g]2" },
    { voice: opllVoice(1), mml: "t84 @11 v7 l4 o4 [c e- g e- a- g e- c]2" },
    { voice: psgVoice(0),  mml: "t84 v7 q7 l2 o2 [cc a-a- ff gg]2" }
]);

// --- State -------------------------------------------------------------------

let face = 0;
let mode = 0;
let sample = 0;
let ramp = 2;
/** Set whenever something changed and the sheet has to be set again. */
let dirty = true;
/** What the last setting cost, in milliseconds. */
let cost = 0;
/** The display line, as it came out: the size that fitted, and the box it filled. */
let displaySize = DISPLAY_SIZES[0];
let displayWidth = 0;
let failure: string | null = null;

// --- Setting the page --------------------------------------------------------

/**
 * The largest of the offered sizes whose line fits the measure. A specimen
 * sheet fits its display line to the page rather than the other way round, and
 * `measure` is what makes that arithmetic possible without drawing anything.
 */
function fit(text: Typesetter, line: string, style: TextStyle, width: number, sizes: readonly number[]): number {
    for (const size of sizes) {
        if (text.measure(line, { ...style, size }).width <= width) return size;
    }
    return sizes[sizes.length - 1];
}

/**
 * Greedy wrapping, on the same measurements the rasteriser will use. Latin text
 * breaks at its spaces; the Japanese sample has none, so it breaks between
 * characters - crude by the standards of a typesetter and exactly what an
 * eight-bit machine would have done.
 */
function wrap(text: Typesetter, source: string, style: TextStyle, width: number): string[] {
    const spaced = source.includes(" ");
    const pieces = spaced ? source.split(" ") : [...source];
    const lines: string[] = [];
    let line = "";

    for (const piece of pieces) {
        const candidate = line ? line + (spaced ? " " : "") + piece : piece;
        if (line && text.measure(candidate, style).width > width) {
            lines.push(line);
            line = piece;
        } else {
            line = candidate;
        }
    }
    if (line) lines.push(line);
    return lines;
}

function compose(ctx: Context): void {
    const { gfx, text, screen } = ctx;
    const chosen = SAMPLES[sample];
    const base: TextStyle = { ...FACES[face].style, shades: RAMPS[ramp].shades };

    const started = performance.now();

    gfx.abandon();                                  // drop a headline still arriving
    if (screen.mode.name !== MODES[mode].name) dress(ctx);

    // Margins are a distance across the picture rather than a pixel count, so
    // they double along with everything else in the 512-wide mode.
    const margin = MARGIN * columns(ctx);
    const measure = screen.width - margin * 2;
    gfx.now.clear(PAPER);

    // The display line, queued: the only part of the sheet you watch arrive.
    displaySize = fit(text, chosen.display, base, measure, DISPLAY_SIZES);
    const display = text.draw(margin, MARGIN, chosen.display, { ...base, size: displaySize });
    displayWidth = display.width;
    let y = MARGIN + display.height + 3;

    y += rule(ctx, y) + 4;

    // Set across the measure at the largest size that will take it - and
    // wrapped even so, since a face wide enough to defeat every size on the
    // list should run onto a second line rather than off the page.
    const subhead = { ...base, size: fit(text, chosen.line, base, measure, SUBHEAD_SIZES) };
    y += text.drawNow(margin, y, wrap(text, chosen.line, subhead, measure).join("\n"), subhead).height + 5;

    // The body, wrapped to the measure and cut to what is left of the page.
    const body = { ...base, size: BODY_SIZE, lineHeight: BODY_LEADING };
    const romTop = screen.height - STATUS_HEIGHT - 22;
    const lines = wrap(text, chosen.body, body, measure).slice(0, Math.max(0, ((romTop - 6) - y) / BODY_LEADING) | 0);
    if (lines.length > 0) text.drawNow(margin, y, lines.join("\n"), body);

    rule(ctx, romTop - 6);

    // The same line in the font the machine actually has - which in SCREEN 7
    // is the same 6x8 cell over half-width pixels, so it comes out condensed
    // and twice as much of it fits. On the Japanese sample every glyph of it
    // is a question mark, which is the ROM being honest about what it was given.
    gfx.now.text(margin, romTop, "THE MACHINE'S OWN 6X8 FONT:", RULE);
    gfx.now.text(margin, romTop + 10, chosen.line.toUpperCase().slice(0, (measure / 6) | 0), INK);

    cost = performance.now() - started;
    readout(ctx);
}

/**
 * Sets the mode and lays the palette out in it. Both have to happen together:
 * a mode change is where the sheet's own colours would otherwise be lost.
 */
function dress(ctx: Context): void {
    ctx.screen.setMode(MODES[mode].name);
    // Paper, ink, a grey for the rules, and a red for the running head - then
    // three steps from the paper down to the ink, which is what the ramps
    // spend. Setting them here is the point: the smoothing is the demo's own
    // palette decision, not something `text` went and made.
    ctx.screen.setColor(PAPER, 7, 7, 5);
    ctx.screen.setColor(INK, 0, 0, 1);
    ctx.screen.setColor(RULE, 5, 5, 4);
    ctx.screen.setColor(ACCENT, 6, 1, 0);
    ctx.screen.setColor(PALE, 5, 5, 4);
    ctx.screen.setColor(MID, 3, 3, 3);
    ctx.screen.setColor(DEEP, 1, 1, 2);
}

/** How many of the mode's pixels go where one of SCREEN 5's would: 1, or 2. */
function columns(ctx: Context): number {
    return ctx.screen.width / 256;
}

/** A hairline across the measure, and how much of the page it took. */
function rule(ctx: Context, y: number): number {
    const margin = MARGIN * columns(ctx);
    ctx.gfx.now.fillRect(margin, y, ctx.screen.width - margin * 2, 1, RULE);
    return 1;
}

function readout(ctx: Context): void {
    const { gfx, screen } = ctx;
    const top = screen.height - STATUS_HEIGHT + 1;

    const margin = MARGIN * columns(ctx);
    gfx.now.fillRect(0, top - 2, screen.width, STATUS_HEIGHT + 2, PAPER);
    gfx.now.text(margin, top,
        `SCREEN ${MODES[mode].screen}  ${FACES[face].label}`, ACCENT, PAPER);
    gfx.now.text(margin, top + 8,
        `${RAMPS[ramp].label}  ${displaySize}PX ${displayWidth}W  ${Math.round(cost)}MS`, INK, PAPER);

    // The ramp itself, one swatch a register, at the end of the line: what the
    // smoothing is costing, said in the currency it is paid in.
    const shades = RAMPS[ramp].shades;
    const swatch = 7 * columns(ctx);
    for (let i = 0; i < shades.length; ++i) {
        gfx.now.fillRect(screen.width - margin - (shades.length - i) * (swatch + 1), top + 8, swatch, 7, shades[i]);
    }
}

/** No browser to ask for a face, which is the whole of the demo. Say so. */
function apologise(ctx: Context, why: string): void {
    ctx.gfx.now.clear(PAPER);
    ctx.gfx.now.text(MARGIN, MARGIN, "NO FONTS HERE:", ACCENT);
    ctx.gfx.now.text(MARGIN, MARGIN + 12, why.toUpperCase().slice(0, 38), INK);
    ctx.gfx.now.text(MARGIN, MARGIN + 28, "THE HOST HAS NO TEXT ENGINE TO ASK.", INK);
    ctx.gfx.now.text(MARGIN, MARGIN + 36, "THIS IS THE ROM FONT INSTEAD.", INK);
}

// --- The app -----------------------------------------------------------------

export const demo: App = {
    init(ctx) {
        face = 0;
        mode = 0;
        sample = 0;
        ramp = 2;
        dirty = true;
        failure = null;

        dress(ctx);

        // Chosen once, so every call below passes only what changes.
        ctx.text.style = { color: INK };
        // A face still loading sets as the fallback, silently, so wait for the
        // page's fonts before the first sheet - and set it again when they land.
        void ctx.text.ready().then(() => { dirty = true; });

        ctx.bgm.play(SCORE, { loop: true });
        ctx.sprites.setEnabled(false);
    },

    update(ctx) {
        const { input } = ctx;

        if (input.btnp(BUTTON.RIGHT)) { face = (face + 1) % FACES.length; dirty = true; }
        if (input.btnp(BUTTON.LEFT)) { face = (face + FACES.length - 1) % FACES.length; dirty = true; }
        if (input.btnp(BUTTON.DOWN)) { ramp = (ramp + 1) % RAMPS.length; dirty = true; }
        if (input.btnp(BUTTON.UP)) { ramp = (ramp + RAMPS.length - 1) % RAMPS.length; dirty = true; }
        if (input.btnp(BUTTON.A)) { mode = (mode + 1) % MODES.length; dirty = true; }
        if (input.btnp(BUTTON.B)) { sample = (sample + 1) % SAMPLES.length; dirty = true; }
    },

    draw(ctx) {
        if (dirty) {
            dirty = false;
            try {
                compose(ctx);
                failure = null;
            } catch (error) {
                failure = String(error instanceof Error ? error.message : error);
                apologise(ctx, failure);
            }
        }

        if (failure) return;

        // The headline arriving, along the last two lines of the screen. It is
        // twice the pixels in SCREEN 7, so the bar is scaled to match.
        const bar = Math.min(ctx.screen.width, Math.round(ctx.gfx.work / 40 / columns(ctx)));
        ctx.gfx.now.fillRect(0, ctx.screen.height - 2, ctx.screen.width, 2, PAPER);
        if (bar > 0) ctx.gfx.now.fillRect(0, ctx.screen.height - 2, bar, 2, ACCENT);
    }
};
