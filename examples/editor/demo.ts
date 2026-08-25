// EDITOR - a text screen with no text mode underneath it.
//
// SCREEN 7 is a bitmap: 512 by 212, sixteen colours out of five hundred and
// twelve, and not a character in sight. The grid is 85 by 26 cells of the
// machine's own 6x8 font laid over it by `console`, which is the whole reason
// to do it this way - a V9938 text mode has only the glyphs in a ROM, and the
// ones this machine is eventually going to need were never in one.
//
// Eighty columns was the point of SCREEN 7 on a real MSX2, and eighty columns
// is what is left after the line numbers. The pixels are half as wide as they
// are tall, so the ROM font comes out condensed exactly as an MSX's own 80
// column text did.
//
// The number worth watching is LAST EDIT in the status bar. The editor
// re-emits its whole visible page every frame - twenty-four rows of eighty-five
// cells, unconditionally - and the console compares each cell against a shadow
// buffer and touches VRAM only where they differ. Adding a character to the end
// of a line is worth four of the two thousand two hundred and ten: the
// character, the cell the caret came off, and two digits in the bar saying so.
// Inserting one in the middle is worth the rest of that line, because the rest
// of that line moved.
//
// Scrolling is worth a row rather than a page. The view moving is handed to
// `console.scroll`, which copies the band of pixels between the two bars within
// VRAM and moves the shadow buffer with it, so the rows that were already right
// are not stale and only the uncovered one is drawn - ninety-odd cells for a
// line, where drawing the page again would be all of them.
//
// Nothing here is queued. An editor is the case `gfx.now` exists for: a caret
// that arrives three frames after the key was struck is a broken caret, and
// the console paints straight into VRAM for the same reason LOOM's faders do.
//
// The keyboard is captured, which does two things. The joystick keymap goes
// quiet, so Z and X are letters again, and the host stops the page acting on
// the keys itself - no scrolling on space, no going back on backspace. Keys
// held with ctrl or the platform key are deliberately left to the browser,
// which is why this editor has no shortcuts.
//
// What it has not got is Japanese, and the shape of the gap is the point: the
// keyboard carries keystrokes and nothing else - no composition, no candidates
// - because the conversion is meant to happen inside the machine rather than
// in the browser, and the glyphs are meant to come from a cache in a spare
// VRAM page rather than from a ROM that never had them. Both of those go in
// behind the seams that are already here: `Keyboard` and `GlyphSource`.

import { type App, type Context, type KeyEvent } from "../../src/index.js";

// --- The palette --------------------------------------------------------------

const PAPER = 0;
const INK = 15;
/** Line numbers, and the rule between them and the text. */
const DIM = 13;
const RULE = 12;
/** The two bars, and what is written on them. */
const BAR = 4;
const BAR_INK = 15;
/** The modified marker, and the one thing on screen that is not grey. */
const MARK = 10;

// --- The layout ---------------------------------------------------------------

const TITLE_ROW = 0;
const FIRST_ROW = 1;
/** Four digits of line number and the rule after them. */
const GUTTER = 5;
/** Tab stops, in columns. */
const TAB = 4;

/** Filled in once the mode is set and the grid has been fitted to it. */
let textCols = 80;
let viewRows = 24;
let statusRow = 25;

// --- The document -------------------------------------------------------------

const SAMPLE = [
    "FANTASY MSX - EDITOR",
    "",
    "This is a text screen with no text mode underneath it. SCREEN 7 is a",
    "bitmap, and the grid is 85 by 26 cells of the machine's own 6x8 font",
    "laid over it. Eighty columns is what is left after the line numbers,",
    "which is what eighty column text on an MSX2 was for.",
    "",
    "Type something. LAST EDIT in the bar along the bottom counts the cells",
    "that actually reached VRAM for it. Adding a character to the end of a",
    "line is worth four out of two thousand two hundred and ten: the letter,",
    "the cell the caret came off, and two digits in the bar saying so.",
    "Inserting one in the middle is worth the rest of that line, because the",
    "rest of that line moved.",
    "",
    "That number is the whole point of the console. A shadow buffer holds",
    "every cell's character and colours, this page is re-emitted whole on",
    "every single frame, and only the cells that differ are ever painted.",
    "",
    "Scrolling costs a row rather than a page. The console moves the band",
    "of pixels between the two bars with one VRAM to VRAM copy - the",
    "cheapest thing a V9938 does, and the reason text screens scrolled as",
    "fast as they did - and repaints only the row that copy uncovered. That",
    "is ninety-odd cells for a line, against all of them for a page.",
    "",
    "What is missing is Japanese. The keyboard carries keystrokes and no",
    "more: no composition, no candidates. Conversion is meant to happen",
    "inside the machine, where the V9938 can draw the candidate list in",
    "the palette everything else is drawn in, and where a gamepad can pick",
    "from it. The glyphs are meant to come from a cache in a spare VRAM",
    "page - this machine's answer to a kanji ROM it never had.",
    "",
    "Until then: ASCII, eighty columns, and a caret that keeps up."
];

let lines: string[] = [];
let caretLine = 0;
let caretColumn = 0;
/** The column an up or down arrow tries to get back to across short lines. */
let wantColumn = 0;
let top = 0;
let left = 0;
let modified = false;
let keystrokes = 0;
/** Frame of the last keystroke, so the caret stops blinking while typing. */
let lastKey = -100;
/** The row the view was showing last frame, so a move of it can be a scroll. */
let shownTop = 0;
/** What the last edit cost in repainted cells, held until the next one. */
let editCost = 0;

export const demo: App = {
    init(ctx: Context) {
        ctx.screen.setMode("G6");               // SCREEN 7: 512x212, 16 of 512
        ctx.screen.setColor(PAPER, 0, 0, 1);
        ctx.screen.setColor(INK, 7, 7, 7);
        ctx.screen.setColor(DIM, 3, 3, 4);
        ctx.screen.setColor(RULE, 2, 2, 3);
        ctx.screen.setColor(BAR, 1, 2, 5);
        ctx.screen.setColor(MARK, 7, 6, 2);
        ctx.screen.setBackdrop(PAPER);

        // The grid follows the mode, and the mode has just changed under it.
        // `flush` would notice on its own; doing it here means the geometry is
        // right for the `cls` below rather than one frame later.
        const term = ctx.console;
        term.fit();
        textCols = term.cols - GUTTER;
        viewRows = term.rows - 2;
        statusRow = term.rows - 1;

        // The console covers all but a pixel or two at the edges; the clear is
        // what makes those the same colour as the paper.
        ctx.gfx.now.clear(PAPER);
        term.color(INK, PAPER);
        term.cls();

        // Text this app is typed into, rather than played with: the joystick
        // keymap goes quiet and the page stops acting on the keys itself.
        ctx.keyboard.capturing = true;

        lines = [...SAMPLE];
        caretLine = 0;
        caretColumn = 0;
        wantColumn = 0;
        top = 0;
        left = 0;
        shownTop = 0;
        modified = false;
        keystrokes = 0;
        editCost = 0;
    },

    update(ctx: Context) {
        for (const event of ctx.keyboard.take()) {
            handle(event);
            ++keystrokes;
            lastKey = ctx.frame;
        }
        follow();
    },

    draw(ctx: Context) {
        render(ctx);
        // Nothing above queued anything: the console writes straight into VRAM,
        // so the page is finished by the time this returns.
        ctx.console.flush();
    }
};

// --- Editing ------------------------------------------------------------------

function handle(event: KeyEvent): void {
    // Anything held with a modifier belongs to the browser, and the host has
    // already let it through rather than swallowing it.
    if (event.ctrl || event.alt || event.meta) return;

    switch (event.key) {
        case "Enter": return split();
        case "Backspace": return backspace();
        case "Delete": return forwardDelete();
        case "Tab": return insert(" ".repeat(TAB - (caretColumn % TAB)));

        case "ArrowLeft": return moveLeft();
        case "ArrowRight": return moveRight();
        case "ArrowUp": return moveVertically(-1);
        case "ArrowDown": return moveVertically(1);
        case "PageUp": return moveVertically(-viewRows);
        case "PageDown": return moveVertically(viewRows);
        case "Home": caretColumn = 0; wantColumn = 0; return;
        case "End": caretColumn = lines[caretLine].length; wantColumn = caretColumn; return;
    }

    // Everything printable arrives as itself, already shifted and already
    // through the host's layout - which is all `key` is for.
    if (event.key.length === 1) insert(event.key);
}

function insert(text: string): void {
    const line = lines[caretLine];
    lines[caretLine] = line.slice(0, caretColumn) + text + line.slice(caretColumn);
    caretColumn += text.length;
    wantColumn = caretColumn;
    modified = true;
}

function split(): void {
    const line = lines[caretLine];
    lines.splice(caretLine, 1, line.slice(0, caretColumn), line.slice(caretColumn));
    ++caretLine;
    caretColumn = 0;
    wantColumn = 0;
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
    wantColumn = caretColumn;
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
    wantColumn = caretColumn;
}

function moveRight(): void {
    if (caretColumn < lines[caretLine].length) ++caretColumn;
    else if (caretLine < lines.length - 1) { ++caretLine; caretColumn = 0; }
    wantColumn = caretColumn;
}

/** Up and down keep the column they started from, across lines too short for it. */
function moveVertically(rows: number): void {
    caretLine = clamp(caretLine + rows, 0, lines.length - 1);
    caretColumn = Math.min(wantColumn, lines[caretLine].length);
}

/** Scrolls the view the least it can to keep the caret inside it. */
function follow(): void {
    if (caretLine < top) top = caretLine;
    if (caretLine >= top + viewRows) top = caretLine - viewRows + 1;
    if (caretColumn < left) left = caretColumn;
    if (caretColumn >= left + textCols) left = caretColumn - textCols + 1;
}

// --- Drawing ------------------------------------------------------------------

function render(ctx: Context): void {
    const term = ctx.console;
    const width = term.cols;

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

    term.text(0, TITLE_ROW, bar(" UNTITLED.TXT" + (modified ? " *" : "  "),
        "SCREEN 7   512x212   " + width + "x" + term.rows + " CELLS ", width),
        BAR_INK, BAR);

    for (let i = 0; i < viewRows; ++i) {
        const index = top + i;
        const row = FIRST_ROW + i;

        if (index >= lines.length) {
            term.text(0, row, "   ~ ", RULE, PAPER);
            term.text(GUTTER, row, " ".repeat(textCols), INK, PAPER);
            continue;
        }

        term.text(0, row, String(index + 1).padStart(4), index === caretLine ? MARK : DIM, PAPER);
        term.text(4, row, " ", RULE, PAPER);
        term.text(GUTTER, row, fit(lines[index].slice(left, left + textCols), textCols), INK, PAPER);
    }

    term.text(0, statusRow, bar(
        ` LINE ${caretLine + 1} OF ${lines.length}   COL ${caretColumn + 1}${modified ? "   MODIFIED" : ""}`,
        `KEYS ${keystrokes}   LAST EDIT ${editCost} CELLS `, width), BAR_INK, BAR);

    term.locate(GUTTER + caretColumn - left, FIRST_ROW + caretLine - top);
    // Solid for half a second after a keystroke, so it does not blink out from
    // under someone who is typing, and blinking whenever they stop.
    term.cursorOn = ctx.frame - lastKey < 30 || ctx.frame % 32 < 20;
}

/** A bar with something at each end and the paper's colour between them. */
function bar(leftText: string, rightText: string, width: number): string {
    const gap = Math.max(1, width - leftText.length - rightText.length);
    return fit(leftText + " ".repeat(gap) + rightText, width);
}

function fit(text: string, width: number): string {
    return text.length >= width ? text.slice(0, width) : text.padEnd(width);
}

function clamp(value: number, low: number, high: number): number {
    return value < low ? low : value > high ? high : value;
}
