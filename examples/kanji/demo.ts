// KANJI - the font cache, and the page it lives in.
//
// A Japanese MSX2 had a kanji ROM, and a driver that copied the glyphs it
// needed out of it into VRAM so the screen could be built out of VRAM-to-VRAM
// copies. This machine has no such ROM. What it has instead is the host's own
// typefaces, rasterised outside the machine exactly as `text` rasterises
// display type - and then cached in a page of VRAM, which is the ROM's job.
//
// **X shows that page.** It is the most useful key here: the display flips to
// page 1 and you are looking at the font itself, laid out in the order the
// characters were first asked for. Nothing about it is a diagram - it is the
// actual memory the characters on the other page are copied from.
//
// The grid is 16 full-width characters to a line and 13 lines, and that is not
// a layout decision: a 16x16 kanji in a 256-pixel-wide screen leaves room for
// sixteen of them, which is what Japanese MSX software had to work with and why
// it always felt cramped. SCREEN 7 does not give more of them - its pixels are
// half as wide, so the same sixteen characters occupy the same width and get
// twice the detail. That is the whole of what the mode buys, and **Z** shows
// the other half of it by turning the antialiasing on.
//
// What the page holds is a budget, and the readout is the point:
//
//   GLYPHS 128/512   distinct characters cached, and slots to cache them in
//   MISS             times the browser's rasteriser had to be asked
//   EVICT            times a character was thrown out to make room
//
// A page of Japanese is a few hundred distinct characters and the page holds
// 512 half-width slots, so a kanji costs two. **Up and down** change the cell
// size, which changes both how much text fits and how many glyphs the page
// holds - a smaller cell buys both, at the size the type stops being readable.
//
// Nothing is typed here. The keyboard carries keystrokes and the conversion
// that turns them into these characters is the next piece; this is the piece
// that has to exist first, because a candidate list drawn in a font with no
// kanji in it is not a candidate list.

import {
    BUTTON, VramAtlas, textCells,
    type App, type Console, type Context, type TextStyle
} from "../../src/index.js";

// --- The palette --------------------------------------------------------------

const PAPER = 0;
const INK = 15;
/** The two shades an antialiased stroke lands on, palest first. */
const FLANK = 13;
const MID = 14;
const BAR = 4;
const MARK = 10;
const DIM = 12;

/**
 * A face with kanji in it, and monospaced, which a character grid wants: a
 * proportional face draws its Latin wider than half an em and the alphabet
 * spills out of its cells. Whatever the machine running the page calls these.
 */
const FACE = "'Noto Sans Mono CJK JP', 'MS Gothic', 'Osaka-Mono', "
    + "'Hiragino Kaku Gothic ProN', monospace";

/** Cell heights to walk through. 16 is the size a kanji ROM's glyphs were. */
const SIZES = [12, 16, 20];

/** Entries 1 to 3 as the machine booted them, to put back after looking at the page. */
const BOOT: ReadonlyArray<readonly [number, number, number]> = [
    [0, 0, 0], [0, 0, 0], [1, 6, 1], [3, 7, 3]
];

const PASSAGES: ReadonlyArray<{ title: string; lines: readonly string[] }> = [
    {
        title: "かな漢字",
        lines: [
            "この画面に文字モードは",
            "ありません。SCREEN 7 は",
            "ただのビットマップで、",
            "文字はホストの書体から",
            "焼いた 16x16 の絵です。",
            "",
            "焼いたものは VRAM の",
            "ページ 1 に置いてあり、",
            "画面に出ているのはそこ",
            "からのコピーです。",
            "X を押すとその",
            "ページが見えます。"
        ]
    },
    {
        title: "予算",
        lines: [
            "ページは半角 512 枠。",
            "漢字は 2 枠を使うので、",
            "256 字で埋まります。",
            "",
            "あふれると、いちばん",
            "長く使われていない字が",
            "追い出されます。EVICT",
            "がその回数です。",
            "",
            "実機の漢字ROMドライバ",
            "がやっていたことと",
            "同じ仕組みです。"
        ]
    },
    {
        title: "画素の形",
        lines: [
            "SCREEN 7 の画素は縦長で、",
            "横に倍あっても画面の幅は",
            "変わりません。だから全角",
            "16 字という数は SCREEN 5",
            "と同じままです。",
            "",
            "増えるのは字の細かさで、",
            "Z を押すと濃淡が付きます。",
            "レジスタを 2 つ借りるので",
            "ただではありません。",
            "",
            "The Latin runs half as wide."
        ]
    }
];

// --- State --------------------------------------------------------------------

let atlas: VramAtlas | null = null;
let passage = 0;
let size = 1;
let shaded = false;
let showingPage = false;
/** Set when there is no rasteriser to ask - outside a browser, there is not. */
let failure: string | null = null;
let dirty = true;

export const demo: App = {
    init(ctx: Context) {
        ctx.screen.setMode("G6");               // SCREEN 7: 512x212, 16 of 512
        ctx.screen.setColor(PAPER, 0, 0, 1);
        ctx.screen.setColor(INK, 7, 7, 7);
        ctx.screen.setColor(MID, 4, 4, 5);
        ctx.screen.setColor(FLANK, 2, 2, 3);
        ctx.screen.setColor(BAR, 1, 2, 5);
        ctx.screen.setColor(MARK, 7, 6, 2);
        ctx.screen.setColor(DIM, 3, 3, 4);
        ctx.screen.setBackdrop(PAPER);

        passage = 0;
        size = 1;
        shaded = false;
        showingPage = false;
        failure = null;
        dirty = true;
        build(ctx);
    },

    update(ctx: Context) {
        const { input } = ctx;
        if (input.btnp(BUTTON.B)) {
            showingPage = !showingPage;
            // The page the glyphs live in is a picture like any other, and this
            // is the whole trick: point the raster at it.
            lendLevelsAColour(ctx, showingPage);
            ctx.screen.setDisplayPage(showingPage ? (atlas?.page ?? 1) : 0);
        }
        if (input.btnp(BUTTON.A)) { shaded = !shaded; build(ctx); }
        if (input.btnp(BUTTON.LEFT)) { passage = (passage + PASSAGES.length - 1) % PASSAGES.length; dirty = true; }
        if (input.btnp(BUTTON.RIGHT)) { passage = (passage + 1) % PASSAGES.length; dirty = true; }
        if (input.btnp(BUTTON.UP)) { size = Math.min(SIZES.length - 1, size + 1); build(ctx); }
        if (input.btnp(BUTTON.DOWN)) { size = Math.max(0, size - 1); build(ctx); }
    },

    draw(ctx: Context) {
        if (failure) return apologise(ctx);

        // The rasteriser is only reached when a glyph the page has not got is
        // painted, which is inside `flush` rather than inside the laying out -
        // so both halves are under the same guard.
        try {
            if (dirty) {
                dirty = false;
                compose(ctx.console);
            }
            // The status line is redrawn every frame and costs only the digits
            // that changed: the console compares before it paints.
            status(ctx);
            ctx.console.flush();
        } catch (error) {
            failure = String(error instanceof Error ? error.message : error);
            apologise(ctx);
        }
    }
};

/**
 * Builds the atlas and hands it to the console. Everything about a cell's size
 * is decided here, so a change of size is a new atlas rather than a resize -
 * the glyphs in the old one were cut for a cell that no longer exists.
 */
function build(ctx: Context): void {
    const style: TextStyle = { font: FACE, size: SIZES[size] };
    atlas = new VramAtlas(ctx.bios.system.vdp, ctx.screen, ctx.text, {
        page: 1,
        cellHeight: SIZES[size],
        style,
        levels: shaded ? 3 : 1,
        // The palette is an input here as everywhere: these two entries are set
        // in init, and the atlas spends the coverage on them rather than
        // looking for a colour of its own.
        ramp: (ink) => (shaded ? [FLANK, MID, ink] : [ink])
    });

    if (showingPage) lendLevelsAColour(ctx, true);
    ctx.gfx.now.clear(PAPER);
    ctx.console.setFont(atlas);
    ctx.console.color(INK, PAPER);
    ctx.console.cls();
    dirty = true;
}

/**
 * Makes the raw page legible, and says something true while doing it.
 *
 * What is stored in the page is not colours - it is coverage levels, 0 for the
 * paper and 1 upwards for the ink, and the colour is applied on the way out by
 * a table. So a screen pointed straight at the page is showing indices 1 to 3,
 * which no palette entry here has any reason to have set. To look at the font
 * you have to lend those levels a colour, and the ones lent are exactly the
 * ones the text on the other page is drawn in.
 */
function lendLevelsAColour(ctx: Context, on: boolean): void {
    const ramp = shaded ? [FLANK, MID, INK] : [INK];
    for (let level = 1; level <= 3; ++level) {
        const entry = on ? ramp[Math.min(level, ramp.length) - 1] : level;
        const [r, g, b] = on ? ctx.screen.palette[entry] : BOOT[level];
        ctx.screen.setColor(level, r, g, b);
    }
}

/** Lays the passage out. Called when something about it changed, not per frame. */
function compose(term: Console): void {
    const { title, lines } = PASSAGES[passage];
    term.color(INK, PAPER);
    term.cls();

    // The cell size is in the title rather than the readout: it changes when a
    // key is pressed, and the readout has counters to keep still for.
    const heading = ` ${title}`;
    const trailer = `${term.cols}x${term.rows} `;
    const gap = Math.max(1, term.cols - cellsOf(heading) - trailer.length);
    term.text(0, 0, pad(heading + " ".repeat(gap) + trailer, term.cols), MARK, BAR);
    for (let i = 0; i < lines.length && i + 1 < term.rows - 1; ++i) {
        term.text(0, i + 1, pad(lines[i], term.cols), INK, PAPER);
    }
}

/**
 * The readout, in the 32 cells a line of this grid has. Terse because that is
 * all there is: slots taken of slots there are, then the misses and the
 * evictions, which together say whether the page is big enough for the page.
 */
function status(ctx: Context): void {
    const term = ctx.console;
    const stats = atlas?.stats;
    if (!stats) return;

    const left = ` ${stats.used}/${stats.slots} M${stats.misses} E${stats.evictions}`;
    const right = `${stats.size}px ${shaded ? "SOFT" : "HARD"} `;
    const gap = Math.max(1, term.cols - left.length - right.length);
    term.text(0, term.rows - 1, pad(left + " ".repeat(gap) + right, term.cols), INK, BAR);
}

/**
 * What to say when there is no rasteriser. Outside a browser there is nothing
 * to ask for a glyph, and the machine's own font is the only one left - which
 * is exactly the gap this whole module exists to fill, so it says so.
 */
function apologise(ctx: Context): void {
    ctx.gfx.now.clear(PAPER);
    ctx.gfx.now.text(8, 8, "NO RASTERISER IN THIS ENVIRONMENT.", INK);
    ctx.gfx.now.text(8, 20, "SET bios.text.rasteriser, OR RUN THIS IN A BROWSER.", DIM);
    ctx.gfx.now.text(8, 36, (failure ?? "").slice(0, 76), DIM);
    ctx.gfx.now.text(8, 56, "THE ROM FONT IS WHAT IS LEFT, AND IT STOPS AT ASCII 126 -", DIM);
    ctx.gfx.now.text(8, 68, "WHICH IS THE GAP THE ATLAS EXISTS TO FILL.", DIM);
}

function pad(text: string, cells: number): string {
    const width = cellsOf(text);
    return width >= cells ? text : text + " ".repeat(cells - width);
}

/** Cells, not characters - a kanji occupies two of them, and the line is cells. */
function cellsOf(text: string): number {
    let width = 0;
    for (const character of text) width += textCells(character);
    return width;
}
