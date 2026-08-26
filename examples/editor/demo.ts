// EDITOR - a Japanese text editor with nothing on screen the V9938 did not draw.
//
// Three things that were separate demos live here now, because they are one
// thing: a text screen with no text mode underneath it, a font cache in a spare
// VRAM page standing in for the kanji ROM this machine never had, and a
// conversion engine whose candidate list is drawn in cells like everything
// else. Any one of them alone is a diagram. Together they are the machine
// doing the job a Japanese MSX2 was sold to do.
//
// ## The grid
//
// There is no character mode here. The screen is a bitmap and `console` lays a
// grid of 42 by 17 cells over it - each cell six pixels by twelve in SCREEN 5,
// twelve by twelve in SCREEN 7, which comes to the same shape because that
// mode's pixels are half as wide. Nineteen full-width characters to a line,
// which is what a Japanese word processor on a machine this size looked like,
// and the reason it looked like that is arithmetic rather than taste: 212 lines
// divided by a twelve-dot cell is seventeen rows and there is no more screen.
//
// The number worth watching is **EDIT** in the status bar. The whole visible
// page is re-emitted every frame and the console compares each cell against a
// shadow buffer, so only what actually moved reaches VRAM. Adding a character
// to the end of a line costs a handful of cells; inserting one in the middle
// costs the rest of that line, because the rest of that line moved. Scrolling
// costs a row rather than a page - `console.scroll` moves the band of pixels
// between the bars with one VRAM-to-VRAM copy, the cheapest thing the chip
// does, and only the uncovered row needs paint.
//
// ## F1: the face, which is also the mode
//
// **OUTLINE** is the default and runs in SCREEN 7. An outline face has no size
// of its own, so it is cut at whatever em the cell wants, and a 512-wide mode
// gives it twice as many columns to put the stroke in - that is what the extra
// pixels are for, and it is what keeps M and W apart at this size where a
// 256-wide mode cannot.
//
// It is cut at **one coverage level**, not the three the atlas can hold. At
// twelve dots there is no flank to resolve: the grey only spreads a stroke over
// three pixels instead of one, which is a soft, bold-looking face rather than a
// machine's. Both faces are a threshold, and both weigh the same.
//
// **DOT** is JF Dot K12x10 and runs in SCREEN 5, because it cannot do anything
// else. A bitmap face is drawn for exactly one size on exactly one grid, and a
// mode with finer pixels has nothing it can spend them on; `text` would draw
// the em twice as wide to keep the shape, which for a bitmap is just a blur.
// So the face decides the mode rather than the other way round, and switching
// between them is a mode change with the same document laid out on the same
// 42 by 17 grid. That is the comparison: one is the machine's own kind of
// picture, the other is a photograph of type.
//
// ## F2: the page the glyphs live in
//
// The display flips to the atlas page and you are looking at the font itself,
// in the order the characters were first asked for. It is not a diagram - it is
// the memory the text on the other page is copied from. It is also dark until
// it is lent a colour, which is the honest part: the page holds coverage levels
// rather than palette indices, so the levels have to borrow exactly the entries
// the text on the other page is drawn in.
//
// ## Ctrl+Space: conversion
//
// The kana key, where every desktop IME puts it - and here it is also the key
// that spends the money. **The first press fetches the dictionary**, about 15MB
// of Mozc, and nothing is fetched before it: an app that never asks for Japanese
// never pays. Every press after that turns conversion on and off. The status bar
// says which of those the next press will do, because Ctrl+Space is the one
// thing in this editor that cannot be found by looking at the screen.
//
// What comes back is a preedit and a list of candidates **as data**, so the
// preedit sits inline where the caret is and the candidate list is the bar along
// the foot of the screen - in the same palette, the same glyphs and the same
// cells as the document. A host IME would have floated its own window over the
// canvas in the system's typeface, which is a browser drawn on top of a
// machine.
//
// ## The keys
//
//   F1           OUTLINE / DOT, which is SCREEN 7 / SCREEN 5
//   F2           look at the font page
//   Ctrl+Space   the dictionary, then kana / direct
//   Space        convert, then next candidate
//   1..9         take that candidate off the bar
//   Enter        settle it
//   Escape       throw the reading away
//
// Everything else is typed. The keyboard is captured, so Z and X are letters
// rather than the joystick, and the page stops acting on the keys itself; keys
// held with ctrl or the platform key are left to the browser, which is why the
// only commands here are on the function keys an MSX had a row of.
//
// ## Without a rasteriser
//
// Outside a browser there is nothing to ask for a glyph, so this falls back to
// the machine's own 6x8 ROM font and says ROM in the bar. The Japanese comes
// out as question marks, which is exactly what a ROM font has to say about it
// and the reason the atlas exists.

import {
    VramAtlas, connectHechima, romFont,
    type App, type Console, type Context, type GlyphSource, type Ime, type ImeSegment,
    type KeyEvent
} from "../../src/index.js";
import { CELL_HEIGHT, DOT_CELL_WIDTH, dotStyle, loadDotFont, outlineStyle } from "../fonts.js";

// --- The palette --------------------------------------------------------------

const PAPER = 0;
const INK = 15;
/** Line numbers, and the rule between them and the text. */
const DIM = 11;
const RULE = 12;
/** The bars, and the one thing on them that is not grey. */
const BAR = 4;
const MARK = 10;
/** Clauses of the preedit that are not the one being chosen. */
const PREEDIT = 5;

/** Entries 1 to 3 as the machine booted them, to put back after F2. */
const BOOT: ReadonlyArray<readonly [number, number, number]> = [
    [0, 0, 0], [0, 0, 0], [1, 6, 1], [3, 7, 3]
];

// --- The layout ---------------------------------------------------------------

const TITLE_ROW = 0;
const FIRST_ROW = 1;
/** Three digits of line number and the rule after them. */
const GUTTER = 4;
/** Tab stops, in columns. */
const TAB = 4;

/** Filled in by `cut`, once the font and the mode have settled. */
let textCols = 38;
let viewRows = 14;
let statusRow = 15;
let barRow = 16;

// --- The document -------------------------------------------------------------

const SAMPLE = [
    "FANTASY MSX - EDITOR",
    "",
    "この画面に文字モードはありません。",
    "SCREEN 7 はただのビットマップで、",
    "文字はホストの書体から焼いた絵です。",
    "",
    "焼いた字は VRAM のページ 1 にあり、",
    "画面に出ているのはそこからのコピー",
    "です。F2 でそのページがそのまま",
    "見えます。",
    "",
    "F1 で書体が変わります。アウトライン",
    "書体は SCREEN 7、ドット書体は",
    "SCREEN 5。書体が画面を決めます。",
    "",
    "Ctrl+Space で辞書を読み込みます。",
    "15MB。押すまでは何も取りません。",
    "読み込むと、かな漢字変換ができます。",
    "変換中の候補は下の行に出ます。",
    "",
    "Type in English too. The keyboard",
    "carries keystrokes and nothing else:",
    "the conversion happens inside the",
    "machine, and the candidate list is",
    "cells in the palette everything else",
    "is drawn in - which is also why a",
    "gamepad could pick from it.",
    "",
    "この一行を直してみてください。",
    "下の EDIT が、その一字が VRAM に",
    "届いた枡目の数です。",
    "",
    "ROM フォントは ASCII 126 まで。",
    "その先は、このページの中にあります。"
];

// --- State --------------------------------------------------------------------

/** How far the dictionary has got. Nothing is fetched until F3. */
type Phase = "cold" | "loading" | "ready" | "failed";

let lines: string[] = [];
let caretLine = 0;
let caretColumn = 0;
/** The cell an up or down arrow tries to get back to across short lines. */
let wantCell = 0;
let top = 0;
let left = 0;
let modified = false;
/** Frame of the last keystroke, so the caret stops blinking while typing. */
let lastKey = -100;
/** The row the view was showing last frame, so a move of it can be a scroll. */
let shownTop = 0;
/** What the last edit cost in repainted cells, held until the next one. */
let editCost = 0;

let dots = false;
let atlas: VramAtlas | null = null;
/** Null until probed: whether there is anything here that can draw a glyph. */
let rasteriser: boolean | null = null;
/** The bitmap face is 331KB and only fetched if F1 is ever pressed. */
let dotFace: "unasked" | "loading" | "ready" | "missing" = "unasked";
let peeking = false;
let phase: Phase = "cold";
let progress = 0;
let note = "";

export const demo: App = {
    init(ctx: Context) {
        lines = [...SAMPLE];
        caretLine = 0;
        caretColumn = 0;
        wantCell = 0;
        top = 0;
        left = 0;
        shownTop = 0;
        modified = false;
        editCost = 0;

        dots = false;
        atlas = null;
        rasteriser = null;
        peeking = false;
        phase = "cold";
        progress = 0;
        note = "";

        dress(ctx);

        // Typed into rather than played: the joystick keymap goes quiet and the
        // page stops acting on the keys itself.
        ctx.keyboard.capturing = true;
    },

    update(ctx: Context) {
        const { console: term, ime, keyboard } = ctx;

        // The machine's own keys are taken before the engine sees anything.
        // A command is not text, and an engine that swallowed F2 would be
        // holding a key that has nothing to do with what is being typed.
        const typed: KeyEvent[] = [];
        for (const event of keyboard.take()) {
            lastKey = ctx.frame;
            if (!command(ctx, event)) typed.push(event);
        }

        // The engine gets first refusal on the rest, and hands back what it did
        // not want - which is what this document is edited with.
        for (const event of ime.feed(typed)) edit(event, term);
        // Whatever it settled since the last frame belongs to the document now.
        const settled = ime.takeText();
        if (settled) insert(settled);

        follow(term, ime);
    },

    draw(ctx: Context) {
        try {
            render(ctx);
            // Nothing above queued anything: the console writes straight into
            // VRAM, so the page is finished by the time this returns.
            ctx.console.flush();
        } catch (error) {
            // A rasteriser that is not there costs the Japanese, not the
            // editor: fall back to the ROM font and carry on typing.
            note = String(error instanceof Error ? error.message : error).slice(0, 40);
            rasteriser = false;
            cut(ctx);
        }
    }
};

// --- The machine's own keys -----------------------------------------------------

/** True when the key was a command, and so is not text. */
function command(ctx: Context, event: KeyEvent): boolean {
    // Ctrl+Space is where every desktop IME puts the kana switch, and it is the
    // only key here that spends anything: the first press fetches the
    // dictionary, every press after it turns conversion on and off. The host
    // leaves ctrl combinations to the browser, so this one arrives having had
    // no effect on the page.
    if (event.ctrl && event.code === "Space") {
        if (phase === "cold") void begin(ctx);
        else if (phase === "ready") ctx.ime.enabled = !ctx.ime.enabled;
        return true;
    }
    if (event.ctrl || event.alt || event.meta) return true;

    switch (event.code) {
        case "F1": face(ctx, !dots); return true;
        case "F2": peek(ctx, !peeking); return true;
    }

    // A number takes a candidate straight off the bar - the one thing a list
    // drawn by the machine can offer that a browser's window cannot.
    if (ctx.ime.composing && event.key >= "1" && event.key <= "9") {
        return ctx.ime.select(Number(event.key) - 1);
    }
    return false;
}

/**
 * Switches the face, which switches the mode with it.
 *
 * Not a preference: the bitmap face has one grid and wants square pixels, so
 * it is a SCREEN 5 face, and the outline one is worth the finer pixels of
 * SCREEN 7. `fonts.ts` holds the measurements that settle it.
 */
function face(ctx: Context, toDots: boolean): void {
    dots = toDots;
    if (dots && dotFace === "unasked") {
        // Fetched on the first press rather than at boot: 331KB nobody who
        // stays in the outline face ever pays for. Until it lands the atlas
        // holds the fallback's glyphs, and the bar says DOT? rather than DOT.
        dotFace = "loading";
        void loadDotFont(ctx).then((ok) => {
            dotFace = ok ? "ready" : "missing";
            if (dots) cut(ctx);
        });
    }
    dress(ctx);
}

/** Fetches the engine. Everything before this is free; this is the 15MB. */
async function begin(ctx: Context): Promise<void> {
    phase = "loading";
    progress = 0;
    note = "";

    try {
        const hechima = await connectHechima({
            onProgress: (loaded, total) => { progress = total > 0 ? loaded / total : 0; }
        });
        ctx.ime.attach(hechima.session);
        ctx.ime.enabled = true;
        note = `hechima ${hechima.version}`;
        phase = "ready";
    } catch (error) {
        note = String(error instanceof Error ? error.message : error).slice(0, 40);
        phase = "failed";
    }
}

// --- Editing ------------------------------------------------------------------

function edit(event: KeyEvent, term: Console): void {
    switch (event.key) {
        case "Enter": return split();
        case "Backspace": return backspace();
        case "Delete": return forwardDelete();
        case "Tab": return insert(" ".repeat(TAB));

        case "ArrowLeft": return moveLeft();
        case "ArrowRight": return moveRight();
        case "ArrowUp": return moveVertically(-1, term);
        case "ArrowDown": return moveVertically(1, term);
        case "PageUp": return moveVertically(-viewRows, term);
        case "PageDown": return moveVertically(viewRows, term);
        case "Home": caretColumn = 0; wantCell = 0; return;
        case "End": caretColumn = lines[caretLine].length; wantCell = Infinity; return;
    }

    // Everything printable arrives as itself, already shifted and already
    // through the host's layout - which is all `key` is for.
    if (event.key.length === 1) insert(event.key);
}

function insert(text: string): void {
    const line = lines[caretLine];
    lines[caretLine] = line.slice(0, caretColumn) + text + line.slice(caretColumn);
    caretColumn += text.length;
    wantCell = Infinity;
    modified = true;
}

function split(): void {
    const line = lines[caretLine];
    lines.splice(caretLine, 1, line.slice(0, caretColumn), line.slice(caretColumn));
    ++caretLine;
    caretColumn = 0;
    wantCell = 0;
    modified = true;
}

function backspace(): void {
    if (caretColumn > 0) {
        const line = lines[caretLine];
        lines[caretLine] = line.slice(0, caretColumn - 1) + line.slice(caretColumn);
        --caretColumn;
    } else if (caretLine > 0) {
        // Joining two lines: the caret lands where the seam is.
        caretColumn = lines[caretLine - 1].length;
        lines[caretLine - 1] += lines[caretLine];
        lines.splice(caretLine, 1);
        --caretLine;
    } else {
        return;
    }
    wantCell = Infinity;
    modified = true;
}

function forwardDelete(): void {
    const line = lines[caretLine];
    if (caretColumn < line.length) {
        lines[caretLine] = line.slice(0, caretColumn) + line.slice(caretColumn + 1);
    } else if (caretLine < lines.length - 1) {
        lines[caretLine] = line + lines[caretLine + 1];
        lines.splice(caretLine + 1, 1);
    } else {
        return;
    }
    modified = true;
}

function moveLeft(): void {
    if (caretColumn > 0) --caretColumn;
    else if (caretLine > 0) caretColumn = lines[--caretLine].length;
    wantCell = Infinity;
}

function moveRight(): void {
    if (caretColumn < lines[caretLine].length) ++caretColumn;
    else if (caretLine < lines.length - 1) { ++caretLine; caretColumn = 0; }
    wantCell = Infinity;
}

/**
 * Up and down keep the column they started from - in **cells**, not characters,
 * because a column of Japanese and a column of Latin are not the same count.
 * The caret then lands on the character whose cells cover that column, never
 * inside one: half a kanji is not a place.
 */
function moveVertically(rows: number, term: Console): void {
    if (wantCell === Infinity) wantCell = term.measure(lines[caretLine].slice(0, caretColumn));
    caretLine = clamp(caretLine + rows, 0, lines.length - 1);

    const line = lines[caretLine];
    let cell = 0;
    let column = 0;
    for (const character of line) {
        if (cell >= wantCell) break;
        cell += term.measure(character);
        column += character.length;
    }
    caretColumn = Math.min(column, line.length);
}

/** Scrolls the view the least it can to keep the caret inside it. */
function follow(term: Console, ime: Ime): void {
    if (caretLine < top) top = caretLine;
    if (caretLine >= top + viewRows) top = caretLine - viewRows + 1;

    const cell = caretCell(term, ime);
    if (cell < left) left = cell;
    if (cell >= left + textCols) left = cell - textCols + 1;
}

/** Where the caret is along its line, in cells, preedit and all. */
function caretCell(term: Console, ime: Ime): number {
    let cell = term.measure(lines[caretLine].slice(0, caretColumn));
    // Composing: the caret belongs to the clause being chosen, not to the end
    // of the reading, which is where the eye is.
    for (const segment of ime.segments) {
        if (segment.kind === "focus") break;
        cell += term.measure(segment.text);
    }
    return cell;
}

// --- The screen ----------------------------------------------------------------

/** Sets the mode the face wants, its palette, and then cuts the glyphs. */
function dress(ctx: Context): void {
    // The mode change takes the framebuffer with it, the atlas page included,
    // which is why the glyphs are cut after it rather than before.
    ctx.screen.setMode(dots ? "G4" : "G6");
    ctx.screen.setColor(PAPER, 0, 0, 1);
    ctx.screen.setColor(INK, 7, 7, 7);
    ctx.screen.setColor(RULE, 2, 2, 3);
    ctx.screen.setColor(DIM, 3, 3, 4);
    ctx.screen.setColor(BAR, 1, 2, 5);
    ctx.screen.setColor(MARK, 7, 6, 2);
    ctx.screen.setColor(PREEDIT, 2, 3, 6);
    ctx.screen.setBackdrop(PAPER);
    cut(ctx);
}

/** Cuts the glyphs into the spare page and fits the grid to what came back. */
function cut(ctx: Context): void {
    const term = ctx.console;
    term.setFont(glyphs(ctx));

    ctx.gfx.now.clear(PAPER);
    term.color(INK, PAPER);
    term.cls();

    textCols = term.cols - GUTTER;
    viewRows = term.rows - 3;
    statusRow = term.rows - 2;
    barRow = term.rows - 1;
    // The page was just cleared, so there is nothing for a scroll to move.
    shownTop = top;
    // A mode change put the display back on page 0 and took the palette with
    // it, so a peek that was in progress has to be set up again.
    if (peeking) peek(ctx, true);
}

/**
 * Where the glyphs come from. The atlas when there is a rasteriser to fill it,
 * and the machine's own ROM font when there is not - which is not a fallback so
 * much as the thing this whole arrangement exists to get past.
 */
function glyphs(ctx: Context): GlyphSource {
    if (rasteriser === null) {
        try {
            ctx.text.render("A", { size: 8 });
            rasteriser = true;
        } catch {
            rasteriser = false;
        }
    }
    if (!rasteriser) {
        atlas = null;
        return romFont();
    }

    atlas = new VramAtlas(ctx.bios.system.vdp, ctx.screen, ctx.text, {
        page: 1,
        cellHeight: CELL_HEIGHT,
        // The bitmap face has a grid of its own; the outline one takes whatever
        // the mode makes a half-width cell, which is twelve pixels in SCREEN 7.
        cellWidth: dots ? DOT_CELL_WIDTH : undefined,
        style: dots ? dotStyle : outlineStyle(CELL_HEIGHT),
        // A bitmap face is drawn for one size and scaling it is what ruins it;
        // an outline face has no size of its own and has to be given one.
        fit: !dots,
        // One level, which is a threshold: a pixel is ink or it is paper.
        //
        // The atlas will spend coverage on a ramp of three, and at this size it
        // should not. Measured on a screen of this document: the ink of a kanji
        // comes to a third of its cell either way, but three levels put it
        // across twice as many lit pixels - a solid stroke with a grey either
        // side of it. That is not a flank being resolved, there is nothing at
        // twelve dots to resolve; it is the stroke smeared over three pixels
        // instead of one, and it reads as a bold, soft face rather than a
        // machine's. The bitmap face has exactly one level for the same reason,
        // and the two now weigh the same.
        levels: 1
    });
    return atlas;
}

/**
 * Puts the atlas page on the display, and lends its levels a colour to do it.
 *
 * What the page holds is not colours: it is coverage levels, 0 for the paper
 * and 1 upwards for the ink, with the colour applied on the way out by a table.
 * So a screen pointed straight at it is showing indices 1 to 3, which nothing
 * has any reason to have set. The levels borrow exactly the entries the text on
 * the other page is drawn in, and give them back afterwards.
 */
function peek(ctx: Context, on: boolean): void {
    if (!atlas) return;
    peeking = on;
    lendLevelsAColour(ctx, on);
    ctx.screen.setDisplayPage(on ? atlas.page : 0);
}

function lendLevelsAColour(ctx: Context, on: boolean): void {
    // Both faces store one level, so one entry would do - but a page that held
    // three from an earlier cut is still holding them, and a glyph half in the
    // paper's colour is worse than one that is too bright.
    for (let level = 1; level <= 3; ++level) {
        const [r, g, b] = on ? ctx.screen.palette[INK] : BOOT[level];
        ctx.screen.setColor(level, r, g, b);
    }
}

// --- Drawing -------------------------------------------------------------------

/** A run of text with the colours it is drawn in. */
interface Run {
    readonly text: string;
    readonly fg: number;
    readonly bg: number;
}

function render(ctx: Context): void {
    const term = ctx.console;
    const { ime } = ctx;

    // What the previous flush cost, which is what the keystroke before it was
    // worth. Latched rather than shown live, so the number holds still to be
    // read and an idle screen stops writing to its own status bar.
    if (ctx.frame === lastKey + 1) editCost = term.repainted;

    // Moving the view is a scroll, not a repaint. The band between the two bars
    // is copied within VRAM and the shadow buffer moves with it, so the rows
    // that were already right are not stale and the loop below leaves them be.
    if (top !== shownTop && Math.abs(top - shownTop) < viewRows) {
        term.scroll(top - shownTop, FIRST_ROW, viewRows);
    }
    shownTop = top;

    title(term);

    for (let i = 0; i < viewRows; ++i) {
        const index = top + i;
        const row = FIRST_ROW + i;

        if (index >= lines.length) {
            term.text(0, row, "  ~ ", RULE, PAPER);
            term.fill(GUTTER, row, textCols, 1, INK, PAPER);
            continue;
        }

        term.text(0, row, String(index + 1).padStart(3), index === caretLine ? MARK : DIM, PAPER);
        term.text(3, row, " ", RULE, PAPER);
        paint(term, row, runsFor(index, ime));
    }

    status(term, ctx.ime.enabled);
    footer(ctx, term);

    term.locate(GUTTER + caretCell(term, ime) - left, FIRST_ROW + caretLine - top);
    // Solid for half a second after a keystroke, so it does not blink out from
    // under someone who is typing, and blinking whenever they stop.
    term.cursorOn = ctx.frame - lastKey < 30 || ctx.frame % 32 < 20;
}

/** A line, with the preedit standing where the caret is if it is this one. */
function runsFor(index: number, ime: Ime): Run[] {
    const line = lines[index];
    if (index !== caretLine || !ime.composing) return [{ text: line, fg: INK, bg: PAPER }];

    return [
        { text: line.slice(0, caretColumn), fg: INK, bg: PAPER },
        ...ime.segments.map(colour),
        { text: line.slice(caretColumn), fg: INK, bg: PAPER }
    ];
}

/** How a clause of the preedit is marked. Inverted is the attention. */
function colour(segment: ImeSegment): Run {
    if (segment.kind === "focus") return { text: segment.text, fg: PAPER, bg: INK };
    return { text: segment.text, fg: INK, bg: PREEDIT };
}

/**
 * Lays runs of text into a row, from the column the view has scrolled to.
 *
 * Counted in cells rather than characters throughout, and asked of the console
 * rather than assumed: a kanji is two cells in the atlas and one in the ROM
 * font, which draws a question mark for it. A character that does not fit
 * whole in what is left is left out whole - half a kanji is not a character.
 *
 * Every cell of the row is written exactly once, which is not fussiness. The
 * shadow buffer marks a cell stale when it is written with something different,
 * and blanking the row first would mark every cell of it - so a page that
 * blanked and then redrew would cost its whole self every frame, which is the
 * one thing this console is built not to do.
 */
function paint(term: Console, row: number, runs: readonly Run[]): void {
    /** Cells consumed from the start of the line, and the next column to fill. */
    let cell = 0;
    let col = 0;

    for (const run of runs) {
        for (const character of run.text) {
            const width = term.measure(character);
            const at = cell - left;
            cell += width;

            if (at < col) continue;                       // scrolled off the left
            if (at + width > textCols) { col = blank(term, row, col); return; }
            // A character half off the left edge leaves a gap rather than half
            // of itself, and the gap is paper.
            if (at > col) term.fill(GUTTER + col, row, at - col, 1, INK, PAPER);
            term.put(GUTTER + at, row, character, run.fg, run.bg);
            col = at + width;
        }
    }
    blank(term, row, col);
}

/** Paper from `col` to the right edge of the text. */
function blank(term: Console, row: number, col: number): number {
    if (col < textCols) term.fill(GUTTER + col, row, textCols - col, 1, INK, PAPER);
    return textCols;
}

function title(term: Console): void {
    const stats = atlas?.stats;
    const right = stats ? `${stats.used}/${stats.slots} M${stats.misses} ` : "ROM ";
    term.text(0, TITLE_ROW, ends(term, " UNTITLED.TXT" + (modified ? " *" : ""), right), INK, BAR);
}

/**
 * Where the caret is, what conversion is doing, and what the last edit cost.
 *
 * The middle one is there because Ctrl+Space is the only thing in this editor
 * that cannot be found by looking at the screen - the function keys have a row
 * of labels along the foot and the kana key has nowhere to be but here. It is
 * dropped rather than allowed to push the ends off the line, which happens
 * around line 1000 of a modified document.
 */
function status(term: Console, converting: boolean): void {
    const left = ` L${caretLine + 1}/${lines.length} C${caretColumn + 1}${modified ? " MOD" : ""}`;
    const right = `EDIT ${editCost} `;
    const middle = conversion(converting);

    const room = term.cols - term.measure(left) - term.measure(right);
    const width = term.measure(middle);
    const gap = width + 2 <= room ? Math.floor((room - width) / 2) : -1;

    const line = gap < 0
        ? ends(term, left, right)
        : left + " ".repeat(gap) + middle + " ".repeat(room - width - gap) + right;
    term.text(0, statusRow, line, INK, BAR);
}

/** What the kana key is offering, which is not the same thing at each stage. */
function conversion(converting: boolean): string {
    // The ROM font has no kana, so where it is the one drawing, this says the
    // same thing in the alphabet it does have.
    const kana = rasteriser ? "かな漢字" : "KANA-KANJI";
    switch (phase) {
        case "cold": return `C-Space:${kana} 15MB`;
        case "loading": return `${kana} ${Math.round(progress * 100)}%`;
        case "failed": return `${kana} ${rasteriser ? "失敗" : "FAILED"}`;
        default: return `C-Space:${kana} ${converting ? "ON" : "OFF"}`;
    }
}

/**
 * The foot of the screen: the candidate list while there is one, the function
 * key labels the rest of the time. A Japanese machine put the candidates here
 * rather than under the caret because a line is nineteen full-width characters
 * and a popup would cover the sentence it is about.
 */
function footer(ctx: Context, term: Console): void {
    const cols = term.cols;

    if (phase === "loading") {
        const filled = Math.round(progress * cols);
        for (let i = 0; i < cols; ++i) term.put(i, barRow, "█", i < filled ? MARK : RULE, PAPER);
        return;
    }

    // Written left to right and blanked only from where it stopped, for the
    // same reason `paint` is: a bar blanked and then redrawn would cost its
    // whole width every frame, and this one has kanji on it.
    const list = ctx.ime.candidates;
    let col = 0;

    if (list.length > 0) {
        for (let i = 0; i < list.length && col < cols; ++i) {
            const label = `${i + 1}:${list[i]}`;
            const width = term.measure(label) + 1;
            if (col + width > cols) break;
            // The chosen one is inverted, which is the only marking a bar of
            // cells has and the one a FEP used.
            const chosen = i === ctx.ime.selected;
            term.text(col, barRow, label, chosen ? PAPER : INK, chosen ? MARK : PAPER);
            term.text(col + width - 1, barRow, " ", INK, PAPER);
            col += width;
        }
        if (col < cols) term.fill(col, barRow, cols - col, 1, INK, PAPER);
        return;
    }

    term.text(col++, barRow, " ", INK, BAR);
    for (const [key, label] of labels()) {
        term.text(col, barRow, key, MARK, BAR);
        col += 2;
        term.text(col, barRow, " " + label + " ", INK, BAR);
        col += term.measure(label) + 2;
    }
    if (col < cols) term.fill(col, barRow, cols - col, 1, INK, BAR);
}

/** What the function keys do right now, which is not always the same thing. */
function labels(): ReadonlyArray<readonly [string, string]> {
    const faceName = !rasteriser ? "ROM" : dots ? (dotFace === "ready" ? "DOT" : "DOT?") : "OUTLINE";
    // In the ROM font the labels have to be Latin, because the ROM font is
    // Latin. A bar that reads ?? is a bar that is lying about the machine.
    const back = rasteriser ? "戻る" : "BACK";
    return [["F1", faceName], ["F2", peeking ? back : "VRAM"]];
}

/** Something at each end of a row, with the bar's own colour between them. */
function ends(term: Console, left: string, right: string): string {
    const gap = Math.max(1, term.cols - term.measure(left) - term.measure(right));
    return left + " ".repeat(gap) + right;
}

function clamp(value: number, low: number, high: number): number {
    return value < low ? low : value > high ? high : value;
}
