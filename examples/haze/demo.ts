// HAZE - the mode nobody used, at sixty pictures a second.
//
// SCREEN 3 is the MSX's forgotten screen: 64x48 blocks of 4x4 pixels, sixteen
// colours, and no way to draw a diagonal. What it has instead is smallness.
// The whole picture is 2048 bytes of pattern table, few enough that every
// block of it can be recomputed between two frames - 2048 OUTIs is about
// 33,000 of the 59,000 cycles a Z80 gets in a frame, so this is a thing the
// real machine could just about have done, and largely did not.
//
// So nothing here is queued and nothing arrives late. The blitter never
// appears in this file, and neither does `gfx`: both of them draw into the
// bitmap modes' nibble-per-pixel framebuffer, which SCREEN 3 has not got. Its
// pixels live in a pattern generator table, four blocks to the byte, in the
// order the VDP fetches them rather than the order they appear on screen.
// `blast` is that order, and it is the only place the layout is known.
//
// The rest is what a mode this coarse turns out to be good at:
//
//   - sixteen colours chosen from 512, rewritten every frame. Rotating the
//     palette moves the whole picture without touching a byte of it, which is
//     the oldest trick there is and still the cheapest.
//   - R23, the vertical scroll register. It shifts the display by lines rather
//     than blocks and wraps at 256, so the field is 64 rows tall with 48 of
//     them on screen, and it slides a quarter of a block at a time for free.
//   - the beat. A quarter note at tempo 150 is exactly 24 frames, because the
//     music driver resolves tempo to whole frames on the vertical interrupt.
//     The palette can flash on the beat without anything having to tell it
//     where the beat is.
//
// The readout along the bottom is four hardware sprites. SCREEN 3 gets MSX1
// sprites - one colour each, and only four of them on any one line - which is
// why it is eight characters wide and no wider. It has no colours of its own
// either: the picture owns all sixteen and keeps rotating them, so every frame
// the readout asks the palette which entry is darkest, lays its bar in that,
// and writes on it in the brightest.

import {
    BUTTON, CHAR_HEIGHT, FONT, compile, glyphOffset, opllVoice, psgVoice, rhythmVoice,
    type App, type Context
} from "../../src/index.js";

// --- The screen --------------------------------------------------------------

/** Blocks across. 32 characters of two blocks each. */
const COLUMNS = 64;
/**
 * Blocks down. Only 48 are on screen; the field is 64 because R23 wraps at 256
 * lines and 64 rows of 4 pixels is exactly that, which makes the scroll seamless.
 */
const ROWS = 64;
const FIELD = COLUMNS * ROWS;

/** Where the centred patterns are centred: the middle of the visible 48 rows. */
const CENTRE_X = 32;
const CENTRE_Y = 24;

// VRAM. SCREEN 3 is a pattern mode, so none of this is a framebuffer: the name
// table says which pattern each character cell uses, and the pattern table
// holds the colours. Every base has to sit on the boundary its register can
// address - 2KB for the patterns, 1KB for the names, 128 bytes for the sprites.
const PATTERN_TABLE = 0x0000;       // 256 patterns x 8 bytes: the picture
const NAME_TABLE = 0x1800;          // 32 rows x 32 names, covering all 64 block rows
const SPRITE_ATTRIBUTES = 0x1c00;
const SPRITE_PATTERNS = 0x2000;

/** Screen line the readout's bar starts on, and its height. */
const STATUS_TOP = 176;
const STATUS_HEIGHT = 16;
/** Eight characters at six pixels each, centred in 256. */
const STATUS_X = (256 - 8 * 6) / 2;

// --- Timing ------------------------------------------------------------------

/** Frames in a quarter note at tempo 150: 3600 / 150, and it divides exactly. */
const BEAT = 24;
const BAR = BEAT * 4;
/** How long a pattern is on screen before the next one takes over. */
const SCENE = BAR * 4;
/** Frames the crossfade between two patterns takes. */
const DISSOLVE = 45;

// --- Tables ------------------------------------------------------------------

/** One turn in 256 steps, -63..63. Four of these still fit in a byte's worth. */
const SINE = new Int8Array(256);
for (let i = 0; i < 256; ++i) SINE[i] = Math.round(Math.sin((i / 256) * Math.PI * 2) * 63);

const sine = (phase: number): number => SINE[phase & 255];

/** Distance from the centre in blocks, and the angle round it in 256ths. */
const RADIUS = new Uint8Array(FIELD);
const ANGLE = new Uint8Array(FIELD);
/** 1/r, scaled: the depth of a tunnel wall seen through this block. */
const DEPTH = new Uint16Array(FIELD);

for (let y = 0; y < ROWS; ++y) {
    for (let x = 0; x < COLUMNS; ++x) {
        const dx = x - CENTRE_X;
        const dy = y - CENTRE_Y;
        const i = y * COLUMNS + x;
        RADIUS[i] = Math.min(255, Math.round(Math.hypot(dx, dy)));
        ANGLE[i] = Math.round((Math.atan2(dy, dx) / (Math.PI * 2)) * 256) & 255;
        DEPTH[i] = Math.min(4095, Math.round(1024 / (Math.hypot(dx, dy) + 1.5)));
    }
}

/**
 * Distance between two blocks, doubled so the rings land on half a block.
 * Indexed by an offset of -64..63 on each axis, which is every pair the field
 * can produce.
 *
 * Vertically it measures the shorter way round: the field wraps at 64 rows and
 * so does everything drawn on it, or a ripple would break where the scroll
 * joins the bottom of the field to the top.
 */
const SPREAD = new Uint8Array(128 * 128);
for (let dy = -64; dy < 64; ++dy) {
    const shorter = ((dy + 32) & 63) - 32;
    for (let dx = -64; dx < 64; ++dx) {
        SPREAD[(dy + 64) * 128 + (dx + 64)] = Math.min(255, Math.round(Math.hypot(dx, shorter) * 2));
    }
}

const spread = (x: number, y: number, cx: number, cy: number): number =>
    SPREAD[((y - cy + 64) & 127) * 128 + ((x - cx + 64) & 127)];

/**
 * A per-block threshold, shuffled, for dissolving one pattern into the next.
 * A fixed order rather than a random draw each frame, so a block that has
 * turned over stays turned over.
 */
const DISSOLVE_ORDER = new Uint8Array(FIELD);
{
    let seed = 0x1234;
    for (let i = 0; i < FIELD; ++i) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        DISSOLVE_ORDER[i] = (seed >> 11) & 0xff;
    }
}

// --- Palettes ----------------------------------------------------------------

type RGB = readonly [number, number, number];

/**
 * Sixteen colours interpolated round a loop of keys. Cyclic on purpose: the
 * patterns below let their values wrap, and a ramp that ends where it started
 * hides the seam - and can be rotated forever without a jump.
 *
 * Every ramp keeps one nearly black key and one nearly white one, which is
 * what the readout borrows for its bar and its letters.
 */
function ramp(keys: readonly RGB[]): RGB[] {
    const colors: RGB[] = [];
    for (let i = 0; i < 16; ++i) {
        const position = (i / 16) * keys.length;
        const first = Math.floor(position);
        const a = keys[first % keys.length];
        const b = keys[(first + 1) % keys.length];
        const f = position - first;
        colors.push([
            Math.round(a[0] + (b[0] - a[0]) * f),
            Math.round(a[1] + (b[1] - a[1]) * f),
            Math.round(a[2] + (b[2] - a[2]) * f)
        ]);
    }
    return colors;
}

const ACID = ramp([[0, 0, 1], [0, 7, 2], [7, 7, 7], [7, 0, 5]]);
const SOLAR = ramp([[0, 0, 0], [7, 0, 0], [7, 5, 0], [7, 7, 6]]);
const DEEP = ramp([[0, 0, 1], [0, 2, 7], [2, 7, 7], [7, 7, 7], [3, 0, 6]]);
const JADE = ramp([[0, 1, 0], [0, 7, 3], [7, 7, 5], [4, 0, 6]]);
const EMBER = ramp([[1, 0, 1], [7, 2, 0], [7, 7, 3], [7, 3, 7]]);

// --- The patterns ------------------------------------------------------------

/**
 * Each one fills the field with colour indices. `t` is the frame count, and
 * every phase is an integer: these ran on machines without a divider and they
 * look the same computed the way those machines had to.
 *
 * `origin` is the field row currently showing at the top of the screen, which
 * the scroll moves. A pattern that repeats can ignore it and let the scroll
 * carry it - as long as it tiles at 64 rows, which is why the vertical
 * frequencies below are all multiples of four steps per block. A pattern with
 * a middle has to count from `origin` instead, or its middle slides off the
 * screen along with everything else.
 */
type Render = (field: Uint8Array, t: number, origin: number) => void;

/** Four sine waves added together, which is the oldest plasma there is. */
const plasma: Render = (field, t) => {
    for (let y = 0; y < ROWS; ++y) {
        const row = y * COLUMNS;
        const vertical = sine(y * 4 + t * 2) + sine(y * 8 - t);
        for (let x = 0; x < COLUMNS; ++x) {
            const v = vertical + sine(x * 6 + t * 3) + sine((x + y) * 4 - t * 2);
            field[row + x] = (v >> 4) & 15;
        }
    }
};

/**
 * A tunnel: colour by 1/r and by the angle at once, and the bands crawl inwards
 * as fast as the eye is willing to believe. The angle runs 0..31 round the
 * circle, and 32 wraps to 0 under the mask, so there is no seam at three
 * o'clock where the arctangent turns over.
 */
const vortex: Render = (field, t, origin) => {
    for (let y = 0; y < ROWS; ++y) {
        const row = y * COLUMNS;
        const table = (((y - origin) & 63) * COLUMNS) | 0;
        for (let x = 0; x < COLUMNS; ++x) {
            field[row + x] = ((DEPTH[table + x] >> 3) + (ANGLE[table + x] >> 3) + (t >> 1)) & 15;
        }
    }
};

/**
 * Two ripples spreading from two points that will not hold still, added
 * together. Where their rings agree the sum is twice a ring and where they
 * disagree it is flat, which is interference, and it is the one thing 4x4
 * blocks are better at than pixels: the pattern is bigger than they are.
 */
const moire: Render = (field, t, origin) => {
    const ax = CENTRE_X + ((sine(t) * 22) >> 6);
    const ay = (CENTRE_Y + origin + ((sine(t * 2 + 64) * 14) >> 6)) & 63;
    const bx = CENTRE_X - ((sine(t * 2 + 96) * 20) >> 6);
    const by = (CENTRE_Y + origin - ((sine(t + 32) * 15) >> 6)) & 63;

    for (let y = 0; y < ROWS; ++y) {
        const row = y * COLUMNS;
        for (let x = 0; x < COLUMNS; ++x) {
            const a = sine(spread(x, y, ax, ay) * 5 + t * 5);
            const b = sine(spread(x, y, bx, by) * 7 - t * 4);
            field[row + x] = ((a + b) >> 3) & 15;
        }
    }
};

/**
 * x XOR y, the pattern every 8-bit machine drew first. Masking to sixteen makes
 * it repeat every sixteen blocks in both directions, so it tiles under the
 * scroll without being asked to.
 */
const lattice: Render = (field, t) => {
    const ox = t >> 1;
    const oy = t >> 2;
    const tint = t >> 3;
    for (let y = 0; y < ROWS; ++y) {
        const row = y * COLUMNS;
        const py = y + oy;
        for (let x = 0; x < COLUMNS; ++x) {
            field[row + x] = (((x + ox) ^ py) + tint) & 15;
        }
    }
};

/**
 * The plasma again, but with the coordinates folded into one eighth of the
 * screen and mirrored back out of it. Folding is two absolute values and a
 * swap, which is the whole of a kaleidoscope.
 */
const kaleido: Render = (field, t, origin) => {
    for (let y = 0; y < ROWS; ++y) {
        const row = y * COLUMNS;
        const table = ((y - origin) & 63) * COLUMNS;
        const dy = Math.abs(((y - origin) & 63) - CENTRE_Y);
        for (let x = 0; x < COLUMNS; ++x) {
            const dx = Math.abs(x - CENTRE_X);
            const near = dx < dy ? dx : dy;
            const far = dx < dy ? dy : dx;
            const v = sine(far * 8 + t * 2) + sine(near * 8 - t)
                + sine((far + near) * 6 + t * 3) + sine(RADIUS[table + x] * 6 - t * 4);
            field[row + x] = (v >> 4) & 15;
        }
    }
};

interface Scene {
    /** Seven characters at most: the readout keeps the eighth for the beat. */
    readonly name: string;
    readonly palette: readonly RGB[];
    /** Palette steps per sixteen frames. Negative rotates the other way. */
    readonly spin: number;
    /** Sixteenths of a scanline of vertical scroll per frame. */
    readonly drift: number;
    readonly render: Render;
}

const SCENES: readonly Scene[] = [
    { name: "PLASMA", palette: ACID, spin: 3, drift: 12, render: plasma },
    { name: "VORTEX", palette: DEEP, spin: -5, drift: 0, render: vortex },
    { name: "MOIRE", palette: EMBER, spin: 4, drift: 0, render: moire },
    { name: "LATTICE", palette: JADE, spin: -3, drift: -20, render: lattice },
    { name: "KALEIDO", palette: SOLAR, spin: 6, drift: 0, render: kaleido }
];

// --- Music -------------------------------------------------------------------

// Eight bars at 150, which is 768 frames, which is two turns of the pattern
// clock. A modal vamp - D minor, then a flat second above it - because the
// picture is already doing enough and a chord that resolves would argue with it.
const SCORE = compile([
    // Three sustained FM voices for the drone, breathing an octave apart.
    { voice: opllVoice(0), mml: "t150 @5 v11 l1 o3 [d e- d c]2" },
    { voice: opllVoice(1), mml: "t150 @5 v9 l1 o4 [a b- a g]2" },
    { voice: opllVoice(2), mml: "t150 @5 v8 l1 o4 [f g- f e-]2" },
    // The fourth arpeggiates over the top in sixteenths, one bar per shape.
    {
        voice: opllVoice(3),
        mml: "t150 @11 v10 l16 o5 [[dfad]4 [e-g-b-e-]4 [dfad]4 [cea c]4]2"
    },
    // PSG bass, where the FM chip is weakest, with the gate short enough to hear
    // each note stop. Root and fifth, four bars, twice.
    {
        voice: psgVoice(0),
        mml: "t150 v12 q5 l8 o2 [d4 d d d4 a a  e-4 e- e- e-4 b- b-  d4 d d d4 a a  c4 c c c4 g g]2"
    },
    // A second PSG voice picking out the top of each chord in sixteenths, cut
    // to a third of its length so it reads as a blip rather than a line.
    {
        voice: psgVoice(1),
        mml: "t150 v9 q3 l16 o5 [d r8 a r8 d r8 f r8 r4  e- r8 b- r8 e- r8 g- r8 r4"
            + "  d r8 a r8 d r8 f r8 r4  c r8 g r8 c r8 e- r8 r4]2"
    },
    { voice: rhythmVoice(), mml: "t150 v10 l8 [{cg} g {dg} g {cg} {cg} {dg} g]8" }
]);

// --- State -------------------------------------------------------------------

const state = {
    /** Frames since the demo started, and the clock everything is phrased in. */
    t: 0,
    scene: 0,
    /** The pattern being dissolved out of, and how far through that is. */
    previous: 0,
    fade: DISSOLVE,
    /** Frame the current pattern started on. */
    startedAt: 0,
    /** Vertical scroll, in sixteenths of a scanline. */
    scroll: 0
};

const field = new Uint8Array(FIELD);
const under = new Uint8Array(FIELD);
const palette: RGB[] = new Array(16).fill([0, 0, 0]);

// --- Writing the picture -----------------------------------------------------

/**
 * The field, packed into the pattern table the way the VDP reads it.
 *
 * A character cell is 8x8 pixels and holds four blocks, two across and two
 * down, as two bytes of two nibbles. Rows of cells share a pattern in groups of
 * four, so the byte a block lands in is its cell's pattern plus an offset for
 * which of the group's four rows it is on and which half of the cell - which is
 * the arithmetic below, hoisted so the inner loop is one write per two blocks.
 */
function blast(vram: Uint8Array, source: Uint8Array): void {
    for (let by = 0; by < ROWS; ++by) {
        const row = PATTERN_TABLE + (by >> 3) * 256 + (((by >> 1) & 3) << 1) + (by & 1);
        const from = by * COLUMNS;
        for (let cell = 0; cell < 32; ++cell) {
            vram[row + (cell << 3)] = (source[from + cell * 2] << 4) | source[from + cell * 2 + 1];
        }
    }
}

/**
 * Names every cell so the 32 rows of the name table address 64 rows of blocks
 * without any two sharing a pattern. Written once: after this the name table is
 * never touched again and the picture is entirely the pattern table.
 */
function nameEveryCell(vram: Uint8Array): void {
    for (let charRow = 0; charRow < 32; ++charRow) {
        for (let column = 0; column < 32; ++column) {
            vram[NAME_TABLE + charRow * 32 + column] = ((charRow >> 2) << 5) | column;
        }
    }
}

/** Lays a flat bar of `color` across the block rows the readout sits on. */
function bar(target: Uint8Array, scroll: number, color: number): void {
    const first = (STATUS_TOP + scroll) >> 2;
    const last = (STATUS_TOP + STATUS_HEIGHT - 1 + scroll) >> 2;
    for (let row = first; row <= last; ++row) {
        const start = (row & 63) * COLUMNS;
        target.fill(color, start, start + COLUMNS);
    }
}

// --- The readout -------------------------------------------------------------

/**
 * Eight characters, as four 16x16 sprites of two characters each.
 *
 * Four is not a layout choice. SCREEN 3 uses the MSX1 sprite mode, which draws
 * four sprites on a line and drops the fifth, so this is the whole width of
 * text the machine will show at once - and the reason a status line here is
 * eight characters rather than forty.
 *
 * R23 offsets sprites along with everything else, so `scroll` is added back to
 * hold the readout still while the picture slides under it.
 */
function writeStatus(vram: Uint8Array, text: string, color: number, scroll: number): void {
    // A sprite's Y of 208 tells the VDP to stop looking at the rest of the
    // table, so it is the one line the readout may not sit on. The scroll
    // carries it across that line eventually; it steps over.
    let y = (STATUS_TOP - 1 + scroll) & 0xff;
    if (y === 208) y = 209;

    for (let sprite = 0; sprite < 4; ++sprite) {
        const left = glyphOffset(text.charCodeAt(sprite * 2));
        const right = glyphOffset(text.charCodeAt(sprite * 2 + 1));
        const pattern = SPRITE_PATTERNS + sprite * 32;

        for (let row = 0; row < 16; ++row) {
            // The glyphs are 5 wide in a 6 wide cell and 8 tall, sat in the
            // middle of the sprite's 16 rows. The chip wants a 16x16 pattern as
            // its left half then its right, sixteen bytes apart.
            const glyph = row - 4;
            const bits = glyph >= 0 && glyph < CHAR_HEIGHT
                ? ((FONT[left + glyph] & 0xf8) << 8) | ((FONT[right + glyph] & 0xf8) << 2)
                : 0;
            vram[pattern + row] = (bits >> 8) & 0xff;
            vram[pattern + 16 + row] = bits & 0xff;
        }

        // Attributes in sprite mode 1 are y, x, name, colour - the colour is in
        // the attribute itself, not in a table of its own the way mode 2 has it.
        const attribute = SPRITE_ATTRIBUTES + sprite * 4;
        vram[attribute] = y;                            // the VDP draws a line lower
        vram[attribute + 1] = STATUS_X + sprite * 12;
        vram[attribute + 2] = sprite * 4;               // 16x16 patterns come in fours
        vram[attribute + 3] = color & 0x0f;
    }
    vram[SPRITE_ATTRIBUTES + 16] = 208;                 // stop the VDP after four
}

// --- Colour ------------------------------------------------------------------

/**
 * Rotates a ramp into the palette and flashes it on the beat.
 *
 * The rotation is the point: the blocks keep their indices and the colours move
 * underneath them, which costs 16 registers a frame instead of 2048 bytes.
 */
function cyclePalette(colors: readonly RGB[], spin: number, beat: number): void {
    // Loudest on the beat and gone six frames later, which at 150 is a little
    // under a quarter of the note. It multiplies rather than washing towards
    // white, so the darkest colour stays dark and the readout keeps its bar.
    const flash = 1 + Math.max(0, 1 - beat / 6) * 0.55;
    for (let i = 0; i < 16; ++i) {
        const c = colors[(((i + spin) % 16) + 16) % 16];
        palette[i] = [
            Math.min(7, Math.round(c[0] * flash)),
            Math.min(7, Math.round(c[1] * flash)),
            Math.min(7, Math.round(c[2] * flash))
        ];
    }
}

/**
 * Which palette entry is currently the darkest, and which the brightest.
 *
 * The brightest is looked for from 1, because a sprite of colour 0 is not a
 * black sprite - the chip skips it, whatever the palette says. The picture has
 * no such rule and the bar may be colour 0 like any other.
 */
function extremes(): { darkest: number; brightest: number } {
    let darkest = 0;
    let brightest = 1;
    let low = 99;
    let high = -1;
    for (let i = 0; i < 16; ++i) {
        // Green counts twice, roughly the way an eye weights it.
        const luma = palette[i][0] + palette[i][1] * 2 + palette[i][2];
        if (luma < low) { low = luma; darkest = i; }
        if (i > 0 && luma > high) { high = luma; brightest = i; }
    }
    return { darkest, brightest };
}

// --- The demo ----------------------------------------------------------------

export const demo: App = {
    init({ bios, screen, bgm }: Context) {
        state.t = 0;
        state.scene = 0;
        state.previous = 0;
        state.fade = DISSOLVE;
        state.startedAt = 0;
        state.scroll = 0;

        const { vdp } = bios.system;

        screen.setMode("MC");           // SCREEN 3: 64x48 blocks of 16 colours
        // The default layout puts the name table and the pattern table both at
        // zero, which is right for a bitmap mode and useless here, so the four
        // tables this mode actually has are placed by hand.
        vdp.setTables({
            layout: NAME_TABLE,
            colors: 0,
            patterns: PATTERN_TABLE,
            spriteAttributes: SPRITE_ATTRIBUTES,
            spritePatterns: SPRITE_PATTERNS
        });
        // Colour 0 is a colour like the other fifteen, rather than a hole
        // showing the border through. The border is set from the picture below,
        // and without this it would take the picture's colour 0 with it.
        vdp.setColor0Opaque(true);
        vdp.setSprites({ size: 16, magnified: false, enabled: true });

        nameEveryCell(vdp.vram);
        vdp.vram.fill(0, PATTERN_TABLE, PATTERN_TABLE + 2048);
        writeStatus(vdp.vram, "        ", 0, 0);

        bgm.play(SCORE, { loop: true });
    },

    update({ input }: Context) {
        ++state.t;

        // Patterns change themselves every four bars; X does not wait.
        const due = state.t - state.startedAt >= SCENE;
        if (due || input.btnp(BUTTON.B)) {
            state.previous = state.scene;
            state.scene = (state.scene + 1) % SCENES.length;
            state.startedAt = state.t;
            state.fade = 0;
        }
        if (state.fade < DISSOLVE) ++state.fade;

        state.scroll += SCENES[state.scene].drift;
    },

    draw({ bios, screen }: Context) {
        const { vram } = bios.system.vdp;
        const scene = SCENES[state.scene];
        const t = state.t;

        cyclePalette(scene.palette, (t * scene.spin) >> 4, t % BEAT);
        const { darkest, brightest } = extremes();
        for (let i = 0; i < 16; ++i) screen.setColor(i, palette[i][0], palette[i][1], palette[i][2]);
        screen.setBackdrop(t % BEAT < 3 ? brightest : darkest);

        const scroll = (state.scroll >> 4) & 255;
        const origin = scroll >> 2;             // field row showing at the top of the screen

        scene.render(field, t, origin);

        // Mid-change, the pattern being left behind is drawn as well and the two
        // are cut together block by block against a fixed shuffled threshold.
        // Every block is rewritten every frame anyway, so a dissolve costs one
        // more pass over the field and nothing at all in VRAM.
        if (state.fade < DISSOLVE) {
            SCENES[state.previous].render(under, t, origin);
            const through = (state.fade / DISSOLVE) * 256;
            for (let i = 0; i < FIELD; ++i) {
                if (DISSOLVE_ORDER[i] >= through) field[i] = under[i];
            }
        }

        bar(field, scroll, darkest);
        blast(vram, field);
        screen.setScroll(scroll);

        // Seven characters of name and one that blinks on the beat, so the
        // readout shows the picture and the music are counting the same frames.
        const beat = t % BEAT < 6 ? "*" : " ";
        writeStatus(vram, (scene.name + "       ").slice(0, 7) + beat, brightest, scroll);
    }
};
