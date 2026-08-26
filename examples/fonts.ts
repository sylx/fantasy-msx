// The two faces a Japanese screen on this machine can be set in, and the
// numbers each of them insists on.
//
// ## The outline face, which is the default
//
// A face with no size of its own: it is drawn from curves, so it is cut at
// whatever em the cell turns out to want, and the coverage that comes back is
// spent on a ramp of palette entries rather than thresholded. That is what
// makes it the default here - it fits any cell in any mode, and in a 512-wide
// mode it gets twice as many columns to put the stroke in. What it cannot do is
// be crisp: at twelve pixels there is no flank to resolve, only a grey where
// the stroke was.
//
// ## The dot face, and why it is the other one
//
// JF Dot K12x10 is a bitmap face: twelve dots across, an em ten tall. That is
// not a style, it is a grid, and everything below is measured from the face
// rather than chosen - a bitmap drawn at any size but its own is a blurred
// bitmap, and the browser will happily give you one.
//
// What the measuring found, rendering U+56FD and counting the distinct coverage
// values that came back (* once snapped - see below):
//
//   size 10, stretch 1   advance 12, half 6, ink 11x9   ONE level - crisp*
//   size 12, stretch 1   advance 14                     33 levels
//   size 20, stretch 1   advance 24                     11 levels
//   size 10, stretch 2   advance 12                      3 levels
//
// Three things follow, two of which decide which screen mode these examples
// run in and one of which decides whether the face is a bitmap at all.
//
// **The em is 10, not 12.** The face's full-width advance is 1.2 em, because
// the twelve dots are wider than the ten-dot em they sit in. Ask for "12px" and
// you get a fourteen-pixel advance and a grey mess.
//
// **The dots do not land on the rows by themselves.** The size settles the
// horizontal - a dot is a pixel across, and a line is set from a whole one -
// but the face hangs its rows 42 units below the baseline, 0.41 of a dot, so
// at ten pixels an em every row of them straddles two of ours: 0.59 of one and
// 0.41 of the next. Which of those lights is then a question about the
// threshold and not about the face - and the face's own `gasp` asks the
// browser to grid-fit above eight pixels, which rounds the straddle outwards
// and turns one row of dots into two. That is this face arriving in bold, with
// the dense kanji filled in solid, and it is what `snap` below is for: cut at
// four times the size, where a rounding of that kind is a quarter of one of
// our pixels, and folded back four rows to one. The measurements above are
// what the face gives once it has been.
//
// **`stretch` has to be 1**, which rules out the 512-wide modes. Their pixels
// are half as wide, so `text` doubles the em to keep type the right shape - and
// doubling an outline is not doubling a bitmap, so it comes out blurred. A
// bitmap face cannot spend the extra columns SCREEN 7 offers; it has exactly
// one size and that size wants square pixels. So a screen set in this face is a
// SCREEN 5 screen, and switching between the two faces is a switch of mode -
// which is the honest way round: the face decides what the machine can be.

import type { Context, TextStyle } from "../src/index.js";

/** The family name the face is registered under, and where it is fetched from. */
export const DOT_FAMILY = "JF Dot K12x10";
export const DOT_URL = "fonts/JF-Dot-k12x10.woff2";

/** The one size at which this face is a bitmap rather than a smudge. */
export const DOT_SIZE = 10;
/**
 * The grid, which both faces are on: twelve rows, so a kanji is the 12x12
 * square the dot face is named for. The em is ten of those twelve - the ink of
 * a full square kanji measures 11x9 - and the two rows left over are the
 * leading. A ten-row cell holds the em exactly and lines of it touch, which is
 * unreadable.
 */
export const CELL_HEIGHT = 12;
/**
 * How wide a half-width cell is in the dot face: six, because that is the grid
 * the face was drawn on, and it is the one number nothing may derive. The
 * outline face has no such opinion, so its cell width is left to the screen -
 * half the height in square pixels, all twelve of them in a 512-wide mode,
 * which is the same shape drawn with twice the columns.
 */
export const DOT_CELL_WIDTH = 6;

/**
 * The outline stack: monospaced, and with kanji in it.
 *
 * Monospaced matters more than it looks. A proportional CJK face draws its
 * Latin wider than half an em, so a grid built on the kanji clips the alphabet
 * and one built on the alphabet shrinks the kanji. This is also what the dot
 * face falls back to where it cannot be fetched, which is every environment
 * that is not a browser.
 */
export const OUTLINE_FAMILY = "'Noto Sans Mono CJK JP', 'MS Gothic', 'Osaka-Mono', "
    + "'Hiragino Kaku Gothic ProN', monospace";

/**
 * The outline face at a given cell height. No `stretch`: it is left to the
 * screen, so a 512-wide mode draws the em twice as wide and spends the extra
 * columns on the letter - which for an outline is exactly what they are for.
 * The size is a starting point; the atlas fits the ink to the cell from there.
 */
export function outlineStyle(size: number): TextStyle {
    return { font: OUTLINE_FAMILY, size };
}

export const dotStyle: TextStyle = {
    font: `'${DOT_FAMILY}', ${OUTLINE_FAMILY}`,
    size: DOT_SIZE,
    // Square pixels, whatever the mode thinks: this face has one grid.
    stretch: 1,
    // And that grid has to land on the machine's. Across it does: a line is
    // set from a whole pixel and the em is ten of them, so a dot is a pixel.
    // Down it does not - this face's rows sit 0.41 of a dot below the baseline
    // and the browser grid-fits them outwards, which is one row of dots
    // arriving as two. `snap` is the answer: cut at four times the size and
    // folded back, one dot to one pixel.
    snap: true
};

/**
 * Fetches the face and waits for it to be usable.
 *
 * Worth an await before anything is baked into the atlas: a face still loading
 * rasterises as the fallback, silently, at the fallback's metrics - and the
 * atlas would cache that. Returns false where there is nothing to fetch it
 * with, which is every environment that is not a browser.
 */
export async function loadDotFont(ctx: Context): Promise<boolean> {
    try {
        await ctx.text.load(DOT_FAMILY, DOT_URL);
        await ctx.text.ready(dotStyle);
        return true;
    } catch {
        return false;
    }
}
