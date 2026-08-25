// IME - typing Japanese, with nothing on screen that the V9938 did not draw.
//
// The browser has an input method and this does not use it. Its candidate
// window floats over the canvas in the system's typeface at the system's size,
// and on a screen of sixteen colours and 16x16 cells that is not a candidate
// window - it is a browser drawn on top of a machine. So the conversion happens
// inside: hechima, which is Mozc built with Emscripten and a session layer with
// no UI of its own, hands back a preedit and a list of candidates **as data**,
// and everything you can see here is cells.
//
// Which buys three things a host IME cannot:
//
//   - the candidate bar is in the palette everything else is in, in the same
//     glyphs, at the same size
//   - a gamepad can pick from it, because it is just a list and an index
//   - a headless run sees exactly what a browser does, so a screenshot of a
//     conversion is a thing that can exist
//
// **The bar along the bottom is the candidate list.** It sits there rather than
// popping up under the caret because a line here is sixteen full-width
// characters and a popup would cover the sentence it is about - which is why
// Japanese MSX software put it at the foot of the screen too.
//
// ## What it costs
//
// About 15MB, nearly all of it Mozc's dictionary, and **Z** is what starts it.
// Nothing is fetched before that. The bar that fills while it comes down is
// drawn in cells like everything else, and once it is in the browser's cache it
// does not come down again.
//
// ## The keys
//
//   Z            load the dictionary
//   Ctrl+Space   kana / direct
//   Space        convert, then next candidate
//   1..9         take that candidate off the bar
//   Enter        settle it
//   Escape       throw the reading away
//   Backspace    delete
//
// Everything else is typed. The joystick keymap is quiet while this is running,
// which is what `keyboard.capturing` means: Z and X are letters here.

import {
    VramAtlas, connectHechima, textCells,
    type App, type Console, type Context, type ImeSegment, type KeyEvent
} from "../../src/index.js";

// --- The palette --------------------------------------------------------------

const PAPER = 0;
const INK = 15;
/** The unconverted reading, and the clauses that are not the one being chosen. */
const PREEDIT = 5;
/** The clause with the attention: drawn inverted, as a FEP always marked it. */
const BAR = 4;
const MARK = 10;
const DIM = 12;

const FACE = "'Noto Sans Mono CJK JP', 'MS Gothic', 'Osaka-Mono', "
    + "'Hiragino Kaku Gothic ProN', monospace";

/** Rows: a title, the sheet, a status line, and the candidate bar under it. */
const TITLE_ROW = 0;
const FIRST_ROW = 1;

// --- State --------------------------------------------------------------------

type Phase = "cold" | "loading" | "ready" | "failed";

let phase: Phase = "cold";
let progress = 0;
let note = "";
let atlas: VramAtlas | null = null;
let sheet = "";
let sheetRows = 10;
let statusRow = 11;
let barRow = 12;

export const demo: App = {
    init(ctx: Context) {
        ctx.screen.setMode("G6");               // SCREEN 7: 512x212, 16 of 512
        ctx.screen.setColor(PAPER, 0, 0, 1);
        ctx.screen.setColor(INK, 7, 7, 7);
        ctx.screen.setColor(PREEDIT, 2, 3, 6);
        ctx.screen.setColor(BAR, 1, 2, 5);
        ctx.screen.setColor(MARK, 7, 6, 2);
        ctx.screen.setColor(DIM, 3, 3, 4);
        ctx.screen.setBackdrop(PAPER);

        phase = "cold";
        progress = 0;
        note = "";
        sheet = "";

        atlas = new VramAtlas(ctx.bios.system.vdp, ctx.screen, ctx.text, {
            page: 1,
            cellHeight: 16,
            style: { font: FACE }
        });

        ctx.gfx.now.clear(PAPER);
        ctx.console.setFont(atlas);
        ctx.console.color(INK, PAPER);
        ctx.console.cls();

        barRow = ctx.console.rows - 1;
        statusRow = barRow - 1;
        sheetRows = statusRow - FIRST_ROW;

        // Typed into rather than played: the joystick keymap goes quiet and the
        // page stops acting on the keys itself.
        ctx.keyboard.capturing = true;
    },

    update(ctx: Context) {
        const { ime, keyboard } = ctx;

        // The engine gets first refusal on every keystroke, and hands back the
        // ones it did not want - which are the ones this sheet edits with.
        for (const event of ime.feed(keyboard.take())) edit(ctx, event);
        // Whatever it settled since the last frame belongs to the document now.
        sheet += ime.takeText();
    },

    draw(ctx: Context) {
        try {
            render(ctx);
            ctx.console.flush();
        } catch (error) {
            // No rasteriser means no glyphs at all, which is the one failure
            // this demo cannot draw its way out of.
            ctx.gfx.now.clear(PAPER);
            ctx.gfx.now.text(8, 8, "NO RASTERISER - RUN THIS IN A BROWSER.", INK);
            ctx.gfx.now.text(8, 24, String(error).slice(0, 76), DIM);
            phase = "failed";
        }
    }
};

// --- Keys the IME did not want -------------------------------------------------

function edit(ctx: Context, event: KeyEvent): void {
    // Ctrl+Space is the switch between converting and not, which is where every
    // desktop IME puts it. The host leaves ctrl combinations to the browser, so
    // this one arrives without the page having acted on it.
    if (event.ctrl && event.code === "Space") {
        if (phase === "ready") ctx.ime.enabled = !ctx.ime.enabled;
        return;
    }
    if (event.ctrl || event.alt || event.meta) return;

    // Z is the only key the sheet does not get, and only while the dictionary
    // has not been asked for. Everything else types from the first frame: an
    // engine is what converts the Latin, not what lets you enter it.
    if (phase === "cold" && (event.key === "z" || event.key === "Z")) {
        void begin(ctx);
        return;
    }

    // A number takes that candidate straight off the bar - the one thing a
    // list drawn by the machine can offer that a browser's window cannot.
    if (ctx.ime.composing && event.key >= "1" && event.key <= "9") {
        if (ctx.ime.select(Number(event.key) - 1)) return;
    }

    if (event.key === "Backspace") { sheet = [...sheet].slice(0, -1).join(""); return; }
    if (event.key === "Enter") { sheet += "\n"; return; }
    if (event.key.length === 1) sheet += event.key;
}

/**
 * Fetches the engine. Everything before this point is free; this is the 15MB,
 * and the progress it reports is drawn on the machine's own screen.
 */
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
        note = String(error instanceof Error ? error.message : error).slice(0, 60);
        phase = "failed";
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
    const cols = term.cols;

    term.text(0, TITLE_ROW, fit(" かな漢字入力", `${cols}x${term.rows} `, cols), MARK, BAR);

    // The sheet is the document with the preedit sitting where the caret is,
    // which is the end of it - the runs carry their own colours so the clause
    // being chosen can be inverted without the layout knowing why.
    const runs: Run[] = [{ text: sheet, fg: INK, bg: PAPER }];
    for (const segment of ctx.ime.segments) runs.push(colour(segment));

    const rows = wrap(runs, cols);
    const top = Math.max(0, rows.length - sheetRows);
    for (let i = 0; i < sheetRows; ++i) {
        const row = rows[top + i];
        term.fill(0, FIRST_ROW + i, cols, 1, INK, PAPER);
        if (row) for (const cell of row) term.put(cell.col, FIRST_ROW + i, cell.text, cell.fg, cell.bg);
    }

    status(ctx, term, cols);
    candidates(ctx, term, cols);
}

/** How a clause of the preedit is marked. Inverted is the attention. */
function colour(segment: ImeSegment): Run {
    if (segment.kind === "focus") return { text: segment.text, fg: PAPER, bg: INK };
    return { text: segment.text, fg: INK, bg: PREEDIT };
}

function status(ctx: Context, term: Console, cols: number): void {
    const stats = atlas?.stats;
    let left: string;

    switch (phase) {
        case "cold": left = " Z: 辞書を読む (15MB)"; break;
        case "loading": left = ` 読み込み中 ${Math.round(progress * 100)}%`; break;
        case "failed": left = ` 失敗 ${note}`; break;
        default: left = ctx.ime.enabled ? " かな" : " 直接入力"; break;
    }

    const right = stats ? `${stats.used}/${stats.slots} ` : "";
    term.text(0, statusRow, fit(left, right, cols), INK, BAR);
}

/**
 * The candidate bar: the focused clause's alternatives, numbered, with the
 * chosen one inverted. While the dictionary is coming down the same row is the
 * progress bar, because it is the row that is free.
 */
function candidates(ctx: Context, term: Console, cols: number): void {
    if (phase === "loading") {
        const filled = Math.round(progress * cols);
        for (let i = 0; i < cols; ++i) term.put(i, barRow, "█", i < filled ? MARK : DIM, PAPER);
        return;
    }

    term.fill(0, barRow, cols, 1, INK, PAPER);
    const list = ctx.ime.candidates;
    if (list.length === 0) {
        if (phase === "ready") term.text(0, barRow, " Space 変換   Ctrl+Space かな/英", DIM, PAPER);
        return;
    }

    let col = 0;
    for (let i = 0; i < list.length && col < cols; ++i) {
        const label = `${i + 1}:${list[i]}`;
        const width = textCells(label) + 1;
        if (col + width > cols) break;
        // The chosen one is inverted, which is the only marking a bar of cells
        // has and the one a FEP used.
        const chosen = i === ctx.ime.selected;
        term.text(col, barRow, label, chosen ? PAPER : INK, chosen ? MARK : PAPER);
        col += width;
    }
}

// --- Laying text out in cells ---------------------------------------------------

interface Cell {
    readonly col: number;
    readonly text: string;
    readonly fg: number;
    readonly bg: number;
}

/**
 * Wraps coloured runs into rows of `cols` cells. Counted in cells rather than
 * characters throughout: a kanji takes two, and a character that will not fit
 * in what is left of a line goes to the next one whole.
 */
function wrap(runs: readonly Run[], cols: number): Cell[][] {
    const rows: Cell[][] = [[]];
    let col = 0;

    for (const run of runs) {
        for (const character of run.text) {
            if (character === "\n") {
                rows.push([]);
                col = 0;
                continue;
            }
            const width = textCells(character);
            if (col + width > cols) {
                rows.push([]);
                col = 0;
            }
            rows[rows.length - 1].push({ col, text: character, fg: run.fg, bg: run.bg });
            col += width;
        }
    }
    return rows;
}

/** Something at each end of a row, and the row's own colour between them. */
function fit(left: string, right: string, cols: number): string {
    const gap = Math.max(1, cols - textCells(left) - textCells(right));
    return left + " ".repeat(gap) + right;
}
