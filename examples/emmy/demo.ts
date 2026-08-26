// EMMY - the screen an eighties conversation game was, in SCREEN 7.
//
// Three bands and nothing else: a masthead, a picture, and a line you type
// into. That arrangement is not a style choice - it is what a Japanese
// adventure game on a machine of this size *had* to be. The picture wants as
// much of the screen as it can get, the conversation needs one line and a
// caret, and there is no third thing, because 212 lines divided by a twelve-dot
// cell is seventeen rows and the picture has already taken nine of them.
//
// ## Why SCREEN 7
//
// The mode is 512x212 in sixteen colours, and its pixels are half as wide as
// they are tall. Both halves of that matter here and they pull the same way.
//
// The type gets twice as many columns to put a stroke in - which is the only
// thing this machine can do for a twelve-pixel kanji, and the difference
// between a legible 会話 and a grey smudge. `text` and the atlas do the
// arithmetic for you: the em is drawn twice as wide, so the same style gives
// type of the same shape with twice the detail across it.
//
// And the picture gets 512 columns of its own. A cut-out at 512x113 is a
// quarter of a megabit of VRAM by itself, which is why this mode costs half of
// the machine's memory and why nothing here flips pages: page 0 is the screen,
// page 1 is the glyphs, and that is both of them.
//
// ## The palette is five registers and a photograph
//
// The picture is fetched, a palette is chosen *for it*, and it is reduced
// against that - but the first five entries are held back before the count
// begins, because everything drawn over the picture has to come from
// somewhere. So the photograph gets eleven colours and the interface gets
// five, and both of those numbers are visible on screen.
//
// One of the five is doing two jobs, which is the sort of thing sixteen
// registers forces and is worth pointing at. FLANK is the palest step of the
// ramp the type's antialiasing is spent on, *and* it is the paper of the input
// field. So the flank of a glyph standing on the field lands on exactly the
// colour behind it: the field costs no extra register, and the smoothing that
// would otherwise halo every stroke on a coloured bar is invisible instead.
//
// ## Typing
//
// The keyboard is captured, so Z and X are letters rather than the joystick.
// Ctrl+Space is the kana key, where every desktop IME puts it, and it is the
// one thing here that spends anything: the first press fetches Mozc, about
// 15MB, and nothing is fetched before it. After that it turns conversion on
// and off.
//
// The conversion happens inside the machine. What comes back from the engine
// is a preedit and a list of candidates as data, so the preedit stands inline
// where the caret is and the candidates are the bar under the field - drawn in
// the same cells, the same glyphs and the same five registers as everything
// else. A browser's own IME would have floated its window over the canvas in
// the system's typeface, which is a browser drawn on top of a machine.
//
// ## The half that answers
//
// An eighties conversation game parsed what you typed against a table of verbs
// and nouns, and the whole art of writing one was hiding how small that table
// was. This one asks the browser instead: Chrome ships a language model behind
// `LanguageModel`, and `mind.ts` is the only file here that knows it exists.
// Nothing crosses a network - it is the same bargain as the fonts and the
// pictures, which are the page's too.
//
// She answers in a balloon over the left of the picture, because that is where
// there is room: her head is about seven tenths of the way across it and the
// rest is couch. The answer is streamed, so the balloon fills a few characters
// at a time, which is what this machine looked like doing anything.
//
// **She remembers nothing.** Every question goes to a clone of a session that
// holds the persona and no conversation, which is partly the built-in model's
// small context and mostly the right amount of memory for a game of this kind.
//
// And **waking her is a key you have to press**, for the same reason the
// dictionary is: the model is measured in gigabytes and a keystroke is not
// consent to fetch one. F1 is that key, and where the model is on the machine
// already it costs a session and no download at all.
//
// ## The keys
//
//   F1           wake her - the browser's model, fetched if it is not here
//   Ctrl+Space   the dictionary, then kana / direct
//   Space        convert, then next candidate
//   1..9         take that candidate off the bar
//   Enter        send the line, and Emmy answers
//   Escape       throw the reading away, or put the balloon away
//
// ## Without a rasteriser
//
// Outside a browser there is nothing to ask for a glyph or for a picture, so
// this falls back to the machine's own 6x8 ROM font and says so. The Japanese
// comes out as question marks, which is exactly what a ROM font has to say
// about it and the reason the atlas exists. There is no model out there either,
// and the bar says that too - the field still takes typing, which is all a
// screenshot of this needs.

import {
    VramAtlas, compile, connectHechima, opllVoice, psgVoice, romFont,
    type App, type Console, type Context, type GlyphSource, type Ime, type ImeSegment,
    type IndexedImage, type KeyEvent, type TextStyle, type Typesetter
} from "../../src/index.js";
import { CELL_HEIGHT, outlineStyle } from "../fonts.js";
import { Mind } from "./mind.js";

/** Vite rewrites this to the built asset's URL, and serves it as it is in dev. */
const PORTRAIT = new URL("./emmy.webp", import.meta.url).href;

// --- The palette --------------------------------------------------------------

/** The backdrop, and what the cut-out's transparent pixels become. */
const PAPER = 0;
/**
 * The palest step of the type's flank - and the paper of the input field, which
 * is the same register doing both jobs. A glyph on the field puts its softest
 * pixels on exactly the colour behind it, so the field is free and the halo a
 * ramp would otherwise draw round every stroke on a coloured bar is not there.
 */
const FLANK = 1;
/** The middle step of the flank, and the ink of everything said quietly. */
const MID = 2;
const INK = 3;
/** Her eyes, the prompt, the caret and the chosen candidate: the one colour. */
const GLOW = 4;
/** Entries held back before the picture's palette is counted. */
const RESERVED = 5;

// --- The layout ---------------------------------------------------------------

/** The band the masthead is set in, above the picture. */
const TITLE_TOP = 9;
const TITLE_SIZE = 28;
/** Air either side of the masthead before its flanking rules start. */
const TITLE_GAP = 14;
const MARGIN = 16;

/** How the masthead is set. Whatever the host calls its serif, tracked wide. */
const TITLE: TextStyle = {
    font: "serif", size: TITLE_SIZE, letterSpacing: 7, shades: [FLANK, MID, INK]
};

/**
 * Rows of the grid, counted from the bottom because that is where they are
 * anchored: the picture is centred and the panel is under it.
 *
 * Row `rows - 4` is deliberately not one of them. The picture is centred in 212
 * lines and comes out 113 tall, so its last two lines are inside that row - and
 * a row nothing writes to is a row the shadow buffer never marks stale, which
 * is how a character grid and a bitmap share a screen without a clip rectangle.
 */
const SAID_ROW = 3;
const FIELD_ROW = 2;
const BAR_ROW = 1;

/** The prompt, in cells the ROM font also has. */
const PROMPT = "> ";

/**
 * The balloon, in the mode's own pixels, and why it is where it is.
 *
 * Her head is about seven tenths of the way across the picture, so everything
 * left of that is couch and is the only part of the artwork a balloon may
 * stand on. This one is a fixed rectangle rather than one that grows to its
 * contents, which is a drawing decision as much as a layout one: a box that
 * keeps still can have its inside repainted as the answer streams in, where a
 * box that grew would have to put the picture back under itself every few
 * characters.
 */
const BALLOON_X = 14;
const BALLOON_Y = 54;
const BALLOON_W = 286;
const BALLOON_H = 100;
/** Air between the border and the words. */
const BALLOON_PAD = 8;
/** The tail: how far right of the balloon it reaches, and how deep its base is. */
const TAIL = 14;
const TAIL_DEPTH = 7;
/** Where the point of it sits, which is her face. */
const TAIL_Y = 88;

/**
 * How Emmy's words are set. The same face and size as the panel, so the balloon
 * and the field read as one machine, and the same ramp - whose palest step is
 * the balloon's own paper, which is why the smoothing does not ring against it.
 */
const REPLY_SIZE = 12;
const REPLY_LEADING = 14;

// --- Music --------------------------------------------------------------------

const SCORE = compile([
    { voice: opllVoice(0), mml: "t66 @11 v7 l1 o3 [d f b- a]2" },
    { voice: opllVoice(1), mml: "t66 @14 v5 l2 o4 [d a f a b- f a d]2" },
    { voice: psgVoice(0),  mml: "t66 v5 q7 l1 o2 [d f b- a]2" }
]);

// --- State --------------------------------------------------------------------

/** How far the dictionary has got. Nothing is fetched until Ctrl+Space. */
type Phase = "cold" | "loading" | "ready" | "failed";

/** The line being typed, and where the caret is in it, counted in code units. */
let line = "";
let caret = 0;
/** Cells the field has scrolled by, when the line is longer than the field. */
let left = 0;
/** The last line sent, which is all the conversation this half of it has. */
let said = "";
/** Frame of the last keystroke, so the caret stops blinking while typing. */
let lastKey = -100;

let atlas: VramAtlas | null = null;
/** Null until probed: whether there is anything here that can draw a glyph. */
let rasteriser: boolean | null = null;
/** Whether the picture arrived, so the panel can say what it is waiting for. */
let picture: "loading" | "shown" | "missing" = "loading";
let phase: Phase = "cold";
let progress = 0;
let note = "";

/** The picture, kept: putting a balloon away means drawing it again. */
let art: IndexedImage | null = null;
let artY = 0;

/** Emmy's half of it, which is the browser's own model behind a persona. */
const mind = new Mind();

/**
 * What the balloon should say, and what it is actually saying on the screen.
 *
 * Two variables rather than one because the balloon is pixels rather than
 * cells: there is no shadow buffer under it, so the only thing stopping it
 * being redrawn sixty times a second is this comparison.
 */
let wanted: string | null = null;
let shown: string | null = null;

export const demo: App = {
    init(ctx: Context) {
        line = "";
        caret = 0;
        left = 0;
        said = "";
        atlas = null;
        rasteriser = null;
        picture = "loading";
        phase = "cold";
        progress = 0;
        note = "";
        art = null;
        wanted = null;
        shown = null;

        dress(ctx);

        // Typed into rather than played: the joystick keymap goes quiet and the
        // page stops acting on the keys itself.
        ctx.keyboard.capturing = true;
        ctx.sprites.setEnabled(false);
        ctx.bgm.play(SCORE, { loop: true });

        void arrive(ctx);
        // The one question about the model that costs nothing: is it here?
        void mind.look();
    },

    update(ctx: Context) {
        const { ime, keyboard } = ctx;

        // The machine's own keys are taken before the engine sees anything: a
        // command is not text, and an engine holding one is holding a key that
        // has nothing to do with what is being typed.
        const typed: KeyEvent[] = [];
        for (const event of keyboard.take()) {
            lastKey = ctx.frame;
            if (!command(ctx, event)) typed.push(event);
        }

        // The engine gets first refusal on the rest and hands back what it did
        // not want, which is what the field is edited with.
        for (const event of ime.feed(typed)) edit(event);
        const settled = ime.takeText();
        if (settled) insert(settled);

        follow(ctx.console, ime);
    },

    draw(ctx: Context) {
        try {
            balloon(ctx);
            panel(ctx);
            // Nothing above queued anything: the console writes straight into
            // VRAM, so the panel is finished by the time this returns.
            ctx.console.flush();
        } catch (error) {
            // A rasteriser that is not there costs the Japanese, not the field:
            // fall back to the ROM font and carry on typing.
            note = message(error);
            rasteriser = false;
            cut(ctx);
        }
    }
};

// --- Bringing the screen up ------------------------------------------------------

/**
 * The mode, the five registers held back, and the grid over the top of them.
 *
 * The mode change takes the framebuffer with it, the atlas page included, which
 * is why the glyphs are cut after it rather than before.
 */
function dress(ctx: Context): void {
    ctx.screen.setMode("G6");
    ctx.screen.setColor(PAPER, 0, 0, 1);
    ctx.screen.setColor(FLANK, 1, 1, 3);
    ctx.screen.setColor(MID, 3, 3, 5);
    ctx.screen.setColor(INK, 7, 7, 7);
    ctx.screen.setColor(GLOW, 2, 6, 7);
    ctx.screen.setBackdrop(PAPER);
    cut(ctx);
}

/**
 * Cuts the glyphs into the spare page, and hands the console a screen it has
 * already accounted for.
 *
 * The flush at the end is the part worth explaining. A fresh grid holds spaces
 * and believes none of them are on the screen yet, so the first flush would
 * paint all 714 of them - and if that happened after the picture landed it
 * would paint the picture out. Doing it here, while the screen really is
 * empty, leaves the shadow buffer agreeing with the framebuffer; every cell
 * outside the panel is then clean for good, and the bitmap under them is safe
 * from a grid that has no reason to touch it again.
 */
function cut(ctx: Context): void {
    const term = ctx.console;
    term.setFont(glyphs(ctx));

    ctx.gfx.now.clear(PAPER);
    term.color(INK, PAPER);
    term.cls();
    term.flush();

    // A hairline where the panel starts, in the panel's own colour: the field's
    // paper, one line of it. Its place is asked of the grid rather than written
    // down, because the ROM font's rows are eight pixels and the atlas's twelve.
    ctx.gfx.now.fillRect(0, term.cellRect(0, term.rows - SAID_ROW).y - 4, ctx.screen.width, 1, FLANK);
}

/**
 * Where the glyphs come from. The atlas when there is a rasteriser to fill it,
 * and the machine's own ROM font when there is not - which is not a fallback so
 * much as the thing this arrangement exists to get past.
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
        // The other half of the mode's 128KB, and the only page left: page 0 is
        // the screen and SCREEN 7 has no third one.
        page: 1,
        cellHeight: CELL_HEIGHT,
        style: outlineStyle(CELL_HEIGHT),
        // An outline cut at twelve pixels has no edge a threshold can find, so
        // the coverage is spent instead: two shades under the ink, and the
        // stroke keeps its weight along its whole length. Two registers, which
        // is what antialiasing costs on this machine.
        //
        // Only the ink is worth it. A candidate drawn inverted, or a line said
        // quietly in MID, is a colour on a colour - a flank in the body's greys
        // would be a halo round it.
        levels: 3,
        ramp: (ink) => (ink === INK ? [FLANK, MID, INK] : [ink, ink, ink])
    });
    return atlas;
}

/**
 * The masthead and the picture, in the order an eighties machine would have
 * managed them: the furniture at once, then the words, then the artwork.
 *
 * Both of the last two are queued rather than written, so they arrive at the
 * rate the V9938 pushes pixels in from outside - about 120 cycles each, which
 * is a dozen frames for the picture. Watching a picture land is not a
 * concession here, it is the thing itself: it is what loading one looked like.
 */
async function arrive(ctx: Context): Promise<void> {
    const { gfx, image, screen, text } = ctx;

    try {
        // A face still loading rasterises as the fallback, silently, at the
        // fallback's metrics - so the masthead waits for the page's fonts.
        await text.ready(TITLE);
        masthead(ctx);
    } catch (error) {
        note = message(error);
    }

    try {
        // Fetched and decoded once, then asked two separate questions: which
        // sixteen colours it would like, and what it looks like in them.
        const source = await image.decode(PORTRAIT);

        // The palette is an input, not an output. `reserve` keeps the five
        // registers the interface is drawn in exactly as `dress` set them, and
        // the picture chooses the other eleven for itself.
        screen.setPalette(image.palette(source, { reserve: RESERVED }));

        // Width only: the height follows the source's proportions, and `reduce`
        // knows this mode's pixels are half as wide - so a 512x225 cut-out
        // comes out 512x113 rather than squeezed to half its height.
        // Kept, and not only for this one drawing: putting a balloon away means
        // drawing the picture again under where it was.
        art = image.reduce(source, { width: screen.width, exclude: [PAPER] });
        // Centred in the screen, which is where the panel and the masthead were
        // measured from in the first place.
        artY = Math.round((screen.height - art.height) / 2);
        image.draw(art, 0, artY, { transparent: true });
        picture = "shown";
    } catch (error) {
        note = message(error);
        picture = "missing";
        gfx.now.text(MARGIN, 100, "NO PICTURE:", MID);
        gfx.now.text(MARGIN, 110, note.toUpperCase().slice(0, 60), MID);
    }
}

/**
 * "Emmy AI", set across the top with a rule running out of it either side.
 *
 * Measured before it is drawn, because a masthead is centred on the page rather
 * than started at a margin, and the rules have to stop where the letters begin.
 * `measure` answers in this mode's own pixels, the doubled em included, so the
 * arithmetic is the same one SCREEN 5 would do.
 */
function masthead(ctx: Context): void {
    const { gfx, screen, text } = ctx;
    const box = text.measure("Emmy AI", TITLE);
    const x = Math.round((screen.width - box.width) / 2);
    const rule = TITLE_TOP + Math.round(box.height * 0.55);

    gfx.now.fillRect(MARGIN, rule, Math.max(0, x - TITLE_GAP - MARGIN), 1, MID);
    gfx.now.fillRect(x + box.width + TITLE_GAP, rule,
        Math.max(0, screen.width - MARGIN - (x + box.width + TITLE_GAP)), 1, MID);

    text.draw(x, TITLE_TOP, "Emmy AI", TITLE);
}

// --- The machine's own keys -------------------------------------------------------

/** True when the key was a command, and so is not text. */
function command(ctx: Context, event: KeyEvent): boolean {
    // The kana key, and the only key here that spends anything. The host leaves
    // ctrl combinations to the browser, so this one arrives having had no
    // effect on the page.
    if (event.ctrl && event.code === "Space") {
        if (phase === "cold") void begin(ctx);
        else if (phase === "ready") ctx.ime.enabled = !ctx.ime.enabled;
        return true;
    }
    if (event.ctrl || event.alt || event.meta) return true;

    // Waking her is a key of its own for the same reason the dictionary is: the
    // model is gigabytes, and a keystroke is not consent to fetch one. It is
    // also a user gesture, which is what the browser wants before it will
    // begin. Where the model is on the machine already this is a session and
    // no download at all.
    if (event.code === "F1") {
        if (mind.state === "absent" || mind.state === "ready") void mind.wake();
        return true;
    }

    // A number takes a candidate straight off the bar - the one thing a list
    // drawn by the machine can offer that a browser's window cannot.
    if (ctx.ime.composing && event.key >= "1" && event.key <= "9") {
        return ctx.ime.select(Number(event.key) - 1);
    }
    return false;
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
        note = message(error);
        phase = "failed";
    }
}

// --- The line ---------------------------------------------------------------------

function edit(event: KeyEvent): void {
    switch (event.key) {
        case "Enter": return send();
        case "Backspace": return backspace();
        case "Delete": return forwardDelete();

        case "ArrowLeft": caret = Math.max(0, caret - 1); return;
        case "ArrowRight": caret = Math.min(line.length, caret + 1); return;
        case "Home": case "ArrowUp": caret = 0; return;
        case "End": case "ArrowDown": caret = line.length; return;
        // Nothing is composing or the engine would have taken this, so it means
        // the other thing on screen that can be dismissed: put the balloon away
        // and have the picture back.
        case "Escape": wanted = null; return;
    }

    // Everything printable arrives as itself, already shifted and already
    // through the host's layout - which is all `key` is for.
    if (event.key.length === 1) insert(event.key);
}

function insert(text: string): void {
    line = line.slice(0, caret) + text + line.slice(caret);
    caret += text.length;
}

function backspace(): void {
    if (caret === 0) return;
    line = line.slice(0, caret - 1) + line.slice(caret);
    --caret;
}

function forwardDelete(): void {
    if (caret >= line.length) return;
    line = line.slice(0, caret) + line.slice(caret + 1);
}

/** Sends the line, and puts the balloon up empty for the answer to arrive in. */
function send(): void {
    if (line === "") return;
    const question = line;
    said = question;
    line = "";
    caret = 0;
    left = 0;
    void think(question);
}

/**
 * One question, one answer, on a session that remembers nothing but who she is.
 *
 * Everything that can go wrong with a model that lives in the browser is a
 * sentence in the balloon rather than a state the app has to be in: there is no
 * model, it has not been fetched, it is being fetched. Emmy says so herself,
 * which is the only place on this screen there is room to say it.
 */
async function think(question: string): Promise<void> {
    // One question at a time. Two streams filling the same balloon would
    // interleave, and the balloon has no way to show that they had.
    if (mind.state === "thinking") return;

    if (mind.state === "unsupported") {
        wanted = `このブラウザには内蔵モデルがありません。（${mind.note}）`;
        return;
    }
    if (mind.state === "absent") {
        wanted = "まだ目が覚めていません。F1 を押すと、ブラウザがモデルを取ってきます。";
        return;
    }
    if (mind.state === "fetching") {
        wanted = "いま目を覚ましているところです。";
        return;
    }

    // The balloon opens empty, so the machine is visibly holding the question
    // rather than having swallowed it. What goes in it until she answers is
    // three dots that move.
    wanted = "";

    // A no-op once the session exists; the first send is what makes it.
    await mind.wake();
    if (mind.state === "failed") {
        wanted = `（${mind.note}）`;
        return;
    }
    // Streamed, so the balloon fills a few characters at a time - which is what
    // this machine looked like doing anything.
    await mind.ask(question, (reply) => { wanted = reply; });
}

/** Scrolls the field the least it can to keep the caret inside it. */
function follow(term: Console, ime: Ime): void {
    const width = term.cols - term.measure(PROMPT);
    const cell = caretCell(term, ime);
    if (cell < left) left = cell;
    if (cell >= left + width) left = cell - width + 1;
    if (left < 0) left = 0;
}

/**
 * Where the caret is along the line, in cells rather than characters - a kanji
 * is two of them in the atlas and one in the ROM font, and only the console
 * knows which font it is holding.
 */
function caretCell(term: Console, ime: Ime): number {
    let cell = term.measure(line.slice(0, caret));
    // Composing: the caret belongs to the clause being chosen, not to the end
    // of the reading, which is where the eye is.
    for (const segment of ime.segments) {
        if (segment.kind === "focus") break;
        cell += term.measure(segment.text);
    }
    return cell;
}

// --- The balloon ---------------------------------------------------------------------

/**
 * What Emmy is saying, over the left of the picture with a tail pointing at her.
 *
 * There is no shadow buffer under this the way there is under the panel - it is
 * pixels on a bitmap, and a bitmap does not remember what was there before. So
 * the balloon keeps its own: `shown` is what is on the screen and `wanted` is
 * what should be, and the three things that can happen between them are all
 * that this does.
 *
 * Putting the balloon away is the case that costs something, because what was
 * underneath it was the artwork. The reduced picture is still in memory, so it
 * is simply drawn again - straight into VRAM rather than through the blitter,
 * since a picture that came back in instalments would be worse than the
 * balloon that was covering it.
 */
function balloon(ctx: Context): void {
    // Nothing may be drawn over a picture that is still arriving: the blitter
    // is working on the same page and would lay its rows over the balloon.
    if (ctx.gfx.pending > 0 || ctx.gfx.busy) return;

    if (wanted === null) {
        if (shown !== null) restore(ctx);
        shown = null;
        return;
    }

    if (shown === null) frame(ctx);
    // Thinking, and nothing said yet: three dots that move, which is the whole
    // of this machine's idea of an hourglass.
    const text = wanted === "" ? "・".repeat(1 + ((ctx.frame >> 4) % 3)) : wanted;
    if (text === shown) return;

    words(ctx, text);
    shown = text;
}

/** The picture again, over whatever was standing on it. */
function restore(ctx: Context): void {
    const { gfx, image, screen } = ctx;
    // No picture to put back, so only the balloon's own box is taken away -
    // clearing the band it was standing in would take the masthead with it.
    if (!art) return gfx.now.fillRect(BALLOON_X, BALLOON_Y, BALLOON_W + TAIL, BALLOON_H, PAPER);

    // The cut-out is drawn transparently, so the paper has to go down first -
    // otherwise the balloon survives wherever the picture has a hole in it.
    gfx.now.fillRect(0, artY, screen.width, art.height, PAPER);
    image.drawNow(art, 0, artY, { transparent: true });
}

/** The box and its tail, which only change when the balloon opens. */
function frame(ctx: Context): void {
    const { gfx } = ctx;
    const right = BALLOON_X + BALLOON_W;

    gfx.now.fillRect(BALLOON_X, BALLOON_Y, BALLOON_W, BALLOON_H, FLANK);
    gfx.now.rect(BALLOON_X, BALLOON_Y, BALLOON_W, BALLOON_H, MID);

    // A tail rather than a triangle drawn with lines: each row is one pixel
    // shorter than the last, which is how a machine with a fill and no
    // rasteriser drew a point.
    for (let i = 0; i <= TAIL_DEPTH; ++i) {
        const width = Math.round(TAIL * (1 - i / TAIL_DEPTH));
        if (width <= 0) continue;
        gfx.now.hline(right, TAIL_Y + i, width, FLANK);
        gfx.now.pixel(right + width - 1, TAIL_Y + i, MID);
        gfx.now.pixel(right + width - 1, TAIL_Y - i, MID);
        if (i > 0) gfx.now.hline(right, TAIL_Y - i, width, FLANK);
    }
    // The border the tail grows out of is not a border any more.
    gfx.now.vline(right - 1, TAIL_Y - TAIL_DEPTH + 1, TAIL_DEPTH * 2 - 1, FLANK);
}

/** The words inside it, wrapped to the box and cut to the lines that fit. */
function words(ctx: Context, text: string): void {
    const { gfx, text: type } = ctx;
    const width = BALLOON_W - BALLOON_PAD * 2;

    // Only the inside is blanked. The border and the tail are the same as they
    // were, and repainting them would make the balloon flicker as it fills.
    gfx.now.fillRect(BALLOON_X + 1, BALLOON_Y + 1, BALLOON_W - 2, BALLOON_H - 2, FLANK);

    // Nothing to set type with, so the machine's own font says what it can -
    // which of Japanese is a row of question marks. Asking the typesetter
    // anyway would throw, and a balloon is not worth taking the screen down for.
    if (!rasteriser) {
        const lines = fold(text, Math.floor(width / 6));
        for (let i = 0; i < lines.length && i * 10 + 8 <= BALLOON_H - BALLOON_PAD * 2; ++i) {
            gfx.now.text(BALLOON_X + BALLOON_PAD, BALLOON_Y + BALLOON_PAD + i * 10, lines[i], INK, FLANK);
        }
        return;
    }

    const style: TextStyle = {
        ...outlineStyle(REPLY_SIZE), lineHeight: REPLY_LEADING, shades: [FLANK, MID, INK]
    };
    const rows = Math.floor((BALLOON_H - BALLOON_PAD * 2) / REPLY_LEADING);
    const lines = wrap(type, text, style, width).slice(0, rows);
    if (lines.length > 0) {
        type.drawNow(BALLOON_X + BALLOON_PAD, BALLOON_Y + BALLOON_PAD, lines.join("\n"), style);
    }
}

/** The same wrapping for a font whose characters are all one width. */
function fold(source: string, columns: number): string[] {
    const lines: string[] = [];
    for (const paragraph of source.split("\n")) {
        for (let at = 0; at < paragraph.length; at += columns) {
            lines.push(paragraph.slice(at, at + columns));
        }
        if (paragraph === "") lines.push("");
    }
    return lines;
}

/**
 * Greedy wrapping on the measurements the rasteriser will use, one character at
 * a time because Japanese has no spaces to break at.
 *
 * Characters are measured singly and the widths added up rather than the line
 * being measured again at every step: the answer arrives a few characters at a
 * time and the balloon is re-wrapped each time, so the cheap way round matters.
 * It ignores what a face does between two particular glyphs, which for a
 * monospaced CJK face is nothing.
 *
 * The one rule of Japanese setting it does keep is the one that shows: a line
 * may not *begin* with a full stop or a closing bracket, so a character of that
 * kind is allowed to hang past the measure rather than fall to the next line.
 */
const NO_START = "、。，．・？！」』）】〉ゝゞーぁぃぅぇぉっゃゅょァィゥェォッャュョ";

function wrap(type: Typesetter, source: string, style: TextStyle, measure: number): string[] {
    const lines: string[] = [];
    let line = "";
    let used = 0;

    for (const character of source) {
        if (character === "\n") {
            lines.push(line);
            line = "";
            used = 0;
            continue;
        }
        const width = type.measure(character, style).width;
        if (line !== "" && used + width > measure && !NO_START.includes(character)) {
            lines.push(line);
            line = character;
            used = width;
        } else {
            line += character;
            used += width;
        }
    }
    if (line !== "") lines.push(line);
    return lines;
}

// --- The panel ---------------------------------------------------------------------

/** A run of text with the colours it is drawn in. */
interface Run {
    readonly text: string;
    readonly fg: number;
    readonly bg: number;
}

/**
 * The three rows under the picture, re-emitted whole every frame.
 *
 * Which costs nothing to say twice: the console compares each cell against its
 * shadow buffer and only what actually changed reaches VRAM, so an idle panel
 * writes no pixels at all and a keystroke writes the cells that moved.
 */
function panel(ctx: Context): void {
    const term = ctx.console;
    const { ime } = ctx;

    const echoRow = term.rows - SAID_ROW;
    const fieldRow = term.rows - FIELD_ROW;
    const barRow = term.rows - BAR_ROW;

    // What was last sent, or what to do if nothing has been.
    const echo = said === "" ? hint() : `${rasteriser ? "あなた" : "YOU"}: ${said}`;
    row(term, echoRow, [{ text: echo, fg: MID, bg: PAPER }], 0, term.cols, PAPER, 0);

    // The field. Its paper is FLANK, which is the register the type's own flank
    // lands on, so the smoothing disappears into the field instead of ringing.
    const prompt = term.measure(PROMPT);
    term.text(0, fieldRow, PROMPT, GLOW, FLANK);
    row(term, fieldRow, runs(ime), prompt, term.cols - prompt, FLANK, left);

    bar(ctx, term, barRow);

    // The caret sits on the cell the next character will take, and the console
    // draws it by inverting that cell - which is the only caret a grid has.
    term.locate(prompt + caretCell(term, ime) - left, fieldRow);
    // Solid for half a second after a keystroke, so it does not blink out from
    // under someone who is typing, and blinking whenever they stop.
    term.cursorOn = ctx.frame - lastKey < 30 || ctx.frame % 32 < 20;
}

/** The line as it stands, with the preedit standing where the caret is. */
function runs(ime: Ime): Run[] {
    if (!ime.composing) return [{ text: line, fg: INK, bg: FLANK }];
    return [
        { text: line.slice(0, caret), fg: INK, bg: FLANK },
        ...ime.segments.map(colour),
        { text: line.slice(caret), fg: INK, bg: FLANK }
    ];
}

/** How a clause of the preedit is marked. Inverted is the attention. */
function colour(segment: ImeSegment): Run {
    if (segment.kind === "focus") return { text: segment.text, fg: FLANK, bg: GLOW };
    return { text: segment.text, fg: INK, bg: MID };
}

/**
 * Lays runs of text into a row, from the cell it has scrolled to.
 *
 * Counted in cells throughout, and asked of the console rather than assumed. A
 * character that does not fit whole in what is left is left out whole: half a
 * kanji is not a character.
 *
 * Every cell is written exactly once, which is not fussiness. The shadow buffer
 * marks a cell stale when it is written with something different, and blanking
 * the row first would mark every cell of it - so a panel that blanked and then
 * redrew would cost its whole self every frame, which is the one thing this
 * console is built not to do.
 */
function row(term: Console, at: number, parts: readonly Run[], col0: number, width: number,
             paper: number, scroll: number): void {
    /** Cells consumed from the start of the line, and the next column to fill. */
    let cell = 0;
    let col = 0;

    for (const part of parts) {
        for (const character of part.text) {
            const cells = term.measure(character);
            const x = cell - scroll;
            cell += cells;

            if (x < col) continue;                        // scrolled off the left
            if (x + cells > width) return blank(term, at, col0 + col, width - col, paper);
            // A character half off the left edge leaves a gap rather than half
            // of itself, and the gap is paper.
            if (x > col) blank(term, at, col0 + col, x - col, paper);
            term.put(col0 + x, at, character, part.fg, part.bg);
            col = x + cells;
        }
    }
    blank(term, at, col0 + col, width - col, paper);
}

function blank(term: Console, at: number, col: number, cells: number, paper: number): void {
    if (cells > 0) term.fill(col, at, cells, 1, INK, paper);
}

/**
 * The bar under the field: the candidates while there are any, and what the
 * kana key is offering the rest of the time.
 *
 * A Japanese machine put the candidates on a line of their own rather than in a
 * popup, because a popup covers the sentence it is about - and on a screen
 * nineteen full-width characters across, that is the whole sentence.
 */
function bar(ctx: Context, term: Console, at: number): void {
    const cols = term.cols;

    if (phase === "loading") {
        const filled = Math.round(progress * cols);
        for (let i = 0; i < cols; ++i) term.put(i, at, "█", i < filled ? GLOW : MID, PAPER);
        return;
    }

    const list = ctx.ime.candidates;
    if (list.length > 0) {
        let col = 0;
        for (let i = 0; i < list.length && col < cols; ++i) {
            const label = `${i + 1}:${list[i]}`;
            const width = term.measure(label) + 1;
            if (col + width > cols) break;
            // The chosen one is inverted, which is the only marking a bar of
            // cells has and the one a FEP used.
            const chosen = i === ctx.ime.selected;
            term.text(col, at, label, chosen ? PAPER : INK, chosen ? GLOW : PAPER);
            term.text(col + width - 1, at, " ", INK, PAPER);
            col += width;
        }
        return blank(term, at, col, cols - col, PAPER);
    }

    // Two engines, one line: the kana key on the left and Emmy on the right,
    // because those are the only two things here that are ever busy.
    row(term, at, [{ text: ends(term, kana(ctx.ime.enabled), emmy()), fg: MID, bg: PAPER }],
        0, cols, PAPER, 0);
}

/** Something at each end of a row, with paper between them. */
function ends(term: Console, left: string, right: string): string {
    const gap = Math.max(1, term.cols - term.measure(left) - term.measure(right));
    return left + " ".repeat(gap) + right;
}

/** Where Emmy is, said in as few cells as it can be. */
function emmy(): string {
    const latin = !rasteriser;
    switch (mind.state) {
        case "unsupported": return latin ? "NO MODEL" : "内蔵モデルなし";
        case "absent": return latin ? "F1: WAKE HER" : "F1: エミーを起こす";
        case "fetching": return `${latin ? "WAKING" : "起きています"} ${Math.round(mind.progress * 100)}%`;
        case "thinking": return latin ? "THINKING" : "考えています";
        case "failed": return latin ? "FAILED" : `失敗: ${mind.note}`;
        default: return latin ? "AWAKE" : "エミー います";
    }
}

/** What the kana key is offering, which is not the same thing at each stage. */
function kana(converting: boolean): string {
    // The ROM font has no kana, so where it is the one drawing, this says the
    // same thing in the alphabet it does have.
    const name = rasteriser ? "かな漢字" : "KANA-KANJI";
    switch (phase) {
        case "cold": return `Ctrl+Space: ${name}  15MB`;
        case "loading": return `${name} ${Math.round(progress * 100)}%`;
        case "failed": return `${name}: ${note}`;
        default: return `Ctrl+Space: ${name} ${converting ? "ON" : "OFF"}`;
    }
}

/** What the field says before anything has been sent to it. */
function hint(): string {
    if (picture === "loading") return rasteriser ? "エミーを読み込んでいます..." : "LOADING...";
    if (!rasteriser) return "TYPE SOMETHING, THEN ENTER.";
    return mind.state === "absent"
        ? "F1 でエミーを起こしてから、話しかけてください。"
        : "話しかけてください。Enter で送信します。";
}

function message(error: unknown): string {
    return String(error instanceof Error ? error.message : error).slice(0, 48);
}
