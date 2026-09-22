// CAVE - a flight through a cave, in the MSX1's own currency: characters.
//
// SCREEN 4 is SCREEN 2's pattern mode with the MSX2's sprites. There is no
// framebuffer here at all. The screen is 32x24 character codes, and every
// frame this throws all of them away and builds the lot again from the cave's
// description - rock, moss, lava, crystals, the score - in a NameBuffer, then
// hands the 768 bytes over in one go. A bitmap mode needs the blitter for two
// frames just to clear itself once; this redraws everything sixty times a
// second and never shows a half-built picture.
//
// It does not scroll by redrawing, though. The name table is a ring 32 columns
// round, the V9958's R26/R27 slide the display along it a pixel at a time, and
// the column coming in on the right is written into the slot that just went
// out on the left, under R25's mask. The score sits in a band of its own, held
// still by the line interrupt.
//
// The lava and the crystals are animated without touching the screen at all.
// Every lava cell is the same character, so rewriting its 8 bytes of pattern
// and 8 of colour makes the whole river boil; the crystals keep their shape
// and cycle only their colour table rows.
//
// Collision reads the name table back: a point of the ship is on rock when the
// code under it is a rock character. The screen is the map.

import {
    BUTTON, NameBuffer, compile, opllVoice, parsePattern, psgVoice, rhythmVoice,
    type App, type Context
} from "../../src/index.js";

// --- Layout ------------------------------------------------------------------

/** Character rows of cave. The two below them are the score. */
export const PLAY_ROWS = 22;
const HUD_TOP = PLAY_ROWS * 8;
const SHIP_SIZE = 16;

/** Codes 32-126 are the font; the cave is drawn in characters from 128 up. */
export const CHAR = {
    EMPTY: 32,
    ROCK: 128,
    CEILING: 129,
    FLOOR: 130,
    LAVA: 131,
    CRYSTAL: 132,
    BURST: 133
} as const;

const DEADLY = new Set<number>([CHAR.ROCK, CHAR.CEILING, CHAR.FLOOR, CHAR.LAVA]);

/** Palette: rock, moss, lava, crystal, ship - picked for the characters, not the MSX defaults. */
const PALETTE: ReadonlyArray<readonly [number, number, number]> = [
    [0, 0, 0], [0, 0, 1],               // 0 is the backdrop's hole; 1 the dark behind it
    [2, 1, 1], [3, 2, 1], [5, 4, 2],    // 2-4 rock: deep, mid, lit
    [1, 5, 1],                          // 5 moss
    [5, 1, 0], [7, 4, 0], [7, 7, 4],    // 6-8 lava: dark, glowing, white-hot
    [1, 2, 6], [3, 6, 7], [7, 7, 7],    // 9-11 crystal
    [5, 5, 6], [7, 2, 2],               // 12-13 ship
    [3, 3, 5], [7, 7, 7]                // 14 dim text, 15 text
];

const ROCK_ART = [
    "32323333",
    "33333233",
    "23333332",
    "33233333",
    "33333323",
    "32333333",
    "33332333",
    "23333333"
];

/** The lowest row of the ceiling: rock, a lit edge, and drips hanging off it. */
const CEILING_ART = [
    "33323333",
    "33333323",
    "23333333",
    "33332333",
    "44444444",
    ".4...44.",
    ".4....4.",
    "......4."
];

/** The top row of the floor: moss on rock. */
const FLOOR_ART = [
    ".5...5..",
    "55.5555.",
    "55555555",
    "45454545",
    "33333233",
    "23333332",
    "33233333",
    "33333323"
];

const CRYSTAL_ART = [
    "...#....",
    "..###...",
    ".##.##..",
    "###.###.",
    ".##.##..",
    "..###...",
    "...#....",
    "........"
];

const SHIP_ART = [
    "................",
    "................",
    "..##............",
    "..####..........",
    "...######.......",
    "...##########...",
    "..##############",
    ".###############",
    ".###############",
    "..##############",
    "...##########...",
    "...######.......",
    "..####..........",
    "..##............",
    "................",
    "................"
];
const SHIP_COLORS = [12, 12, 13, 13, 12, 12, 11, 11, 12, 12, 12, 12, 13, 13, 12, 12];

/** Points of the ship that must not touch rock, relative to its top left. */
const HIT_POINTS: ReadonlyArray<readonly [number, number]> = [
    [3, 3], [3, 12], [8, 5], [8, 10], [14, 7], [14, 8], [2, 7]
];

// --- Sound -------------------------------------------------------------------

const THEME = compile([
    { voice: psgVoice(0), mml: "t140 v11 q6 l8 o5 [e r b a g r e d  e r g a b4 r4  c r g f e r c <b> c r e g f4 r4]2" },
    { voice: psgVoice(1), mml: "t140 v11 q5 l8 o2 [eeee eeee  gggg aaaa  cccc cccc  dddd dddd]2" },
    { voice: opllVoice(0), mml: "t140 @5 v10 l1 o3 [e g c d]2" },
    { voice: rhythmVoice(), mml: "t140 v10 l8 [{cg} g {dg} g {cg} {cg} {dg} g]8" }
]);
const CHIME = "t150 v14 q8 l32 o6 e b >e";
const CRASH = "t150 v15 q8 l32 o3 c <b a g f e d c";

// --- The cave ----------------------------------------------------------------

interface Column {
    /** Rows of rock hanging from the top, the lit edge included. */
    top: number;
    /** Rows of rock standing on the bottom, the mossy edge included. */
    bottom: number;
    /** Whether the floor's surface is lava instead of moss. */
    lava: boolean;
    /** Row of this column's crystal, or -1. */
    crystal: number;
}

/** Deterministic, so a test sees the same cave every time. */
function random(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * The cave, column by column as the camera reaches it. Only the last 64 are
 * kept: the screen needs 33, and nothing ever looks back.
 */
class Cave {
    private readonly ring: Column[] = [];
    private next = 0;
    private top = 2;
    private bottom = 2;
    private lava = false;
    private readonly rand: () => number;

    constructor(seed: number) {
        this.rand = random(seed);
    }

    column(index: number): Column {
        while (this.next <= index) this.ring[this.next & 63] = this.generate(this.next++);
        return this.ring[index & 63]!;
    }

    private generate(index: number): Column {
        const rand = this.rand;
        // Wide and flat to begin with, then narrower the further you get.
        const gap = Math.max(7, 14 - Math.floor(index / 90));
        if (index > 24) {
            this.top += Math.floor(rand() * 3) - 1;
            this.bottom += Math.floor(rand() * 3) - 1;
        }
        this.top = Math.max(1, Math.min(PLAY_ROWS - gap - 2, this.top));
        this.bottom = Math.max(2, Math.min(PLAY_ROWS - gap - this.top, this.bottom));
        if (index > 40 && rand() < (this.lava ? 0.15 : 0.06)) this.lava = !this.lava;

        let crystal = -1;
        const open = PLAY_ROWS - this.top - this.bottom;
        if (index > 16 && rand() < 0.08 && open > 3) crystal = this.top + 1 + Math.floor(rand() * (open - 2));
        return { top: this.top, bottom: this.bottom, lava: index > 40 && this.lava, crystal };
    }
}

/** The character at a row of a column of cave. */
export function cellOf(column: Column, row: number): number {
    const floor = PLAY_ROWS - column.bottom;
    if (row < column.top - 1) return CHAR.ROCK;
    if (row === column.top - 1) return CHAR.CEILING;
    if (row === floor) return column.lava ? CHAR.LAVA : CHAR.FLOOR;
    if (row > floor) return CHAR.ROCK;
    if (row === column.crystal) return CHAR.CRYSTAL;
    return CHAR.EMPTY;
}

// --- State -------------------------------------------------------------------

type Phase = "title" | "flying" | "crashed";

export const state = {
    phase: "title" as Phase,
    cave: new Cave(1),
    /** Plane pixels travelled. The camera is its whole part. */
    distance: 0,
    speed: 1,
    /** Camera as of the last frame drawn, which is what collision checks against. */
    shown: 0,
    x: 40,
    y: 80,
    score: 0,
    best: 0,
    t: 0,
    /** Frames since the crash, and where it happened in plane pixels. */
    crashT: 0,
    crashX: 0,
    crashY: 0
};

/** The screen, rebuilt from nothing every frame. */
const frame = new NameBuffer();

function reset(seed: number): void {
    state.cave = new Cave(seed);
    state.distance = 0;
    state.speed = 1;
    state.shown = 0;
}

// --- Characters --------------------------------------------------------------

function defineCharacters({ tiles }: Context): void {
    tiles.loadFont({ foreground: 15, background: 0 });
    tiles.defineMulticolor(CHAR.ROCK, ROCK_ART);
    tiles.defineMulticolor(CHAR.CEILING, CEILING_ART);
    tiles.defineMulticolor(CHAR.FLOOR, FLOOR_ART);
    tiles.setPattern(CHAR.CRYSTAL, parsePattern(CRYSTAL_ART));
    animate(tiles, 0);
}

/**
 * The characters that move. Each is one pattern shared by every cell showing
 * it, so a few bytes here change all of them at once - the name table is not
 * touched.
 */
function animate(tiles: Context["tiles"], t: number): void {
    // Lava: a surface that rolls, over a body that swirls.
    const rows: number[] = [], colors: number[] = [];
    for (let y = 0; y < 8; ++y) {
        let bits = 0;
        for (let x = 0; x < 8; ++x) {
            const surface = 2 + Math.sin((x + t * 0.25) * 0.8) * 1.2 + Math.sin((x - t * 0.15) * 1.9) * 0.6;
            const swirl = ((x + y * 2 + (t >> 2)) & 7) < 3;
            if (y < 4 ? y >= surface : swirl) bits |= 0x80 >> x;
        }
        rows.push(bits);
        colors.push(y < 2 ? 0x80 : y < 4 ? 0x70 : 0x76);
    }
    tiles.setPattern(CHAR.LAVA, rows);
    tiles.setRowColors(CHAR.LAVA, colors);

    // Crystals: the same shape, the light running down them.
    const cycle = [9, 10, 11, 10];
    const glints: number[] = [];
    for (let y = 0; y < 8; ++y) glints.push(cycle[((t >> 2) + y) & 3]! << 4);
    tiles.setRowColors(CHAR.CRYSTAL, glints);

    // The burst: a ring growing out from the middle.
    const radius = (state.crashT / 3) % 6;
    const burst: number[] = [];
    for (let y = 0; y < 8; ++y) {
        let bits = 0;
        for (let x = 0; x < 8; ++x) {
            const d = Math.hypot(x - 3.5, y - 3.5);
            if (Math.abs(d - radius) < 1 || (d < radius && ((x ^ y ^ state.crashT) & 3) === 0)) bits |= 0x80 >> x;
        }
        burst.push(bits);
    }
    tiles.setPattern(CHAR.BURST, burst);
    tiles.setColor(CHAR.BURST, state.crashT & 4 ? 8 : 7);
}

// --- Flying ------------------------------------------------------------------

/** The code on screen under a screen pixel, read back from the name table. */
function under({ tiles }: Context, x: number, y: number): number {
    if (y < 0 || y >= HUD_TOP) return CHAR.ROCK;
    return tiles.get((state.shown + x) >> 3, y >> 3);
}

function fly(ctx: Context): void {
    const { input, bgm } = ctx;
    const { x, y } = input.axis();
    state.x = Math.max(8, Math.min(200, state.x + x * 2));
    state.y = Math.max(0, Math.min(HUD_TOP - SHIP_SIZE, state.y + y * 2));

    for (const [dx, dy] of HIT_POINTS) {
        const code = under(ctx, state.x + dx, state.y + dy);
        if (code === CHAR.CRYSTAL) {
            // The screen still shows it until the next frame is drawn, and
            // another point of the ship may be on it too.
            const column = state.cave.column((state.shown + state.x + dx) >> 3);
            if (column.crystal < 0) continue;
            column.crystal = -1;
            state.score += 10;
            bgm.effect(psgVoice(2), CHIME);
        } else if (DEADLY.has(code)) {
            crash(ctx, state.x + dx, state.y + dy);
            return;
        }
    }

    state.speed = Math.min(3, 1 + state.distance / 6000);
    state.distance += state.speed;
    if ((state.t & 15) === 0) state.score += 1;
}

function crash(ctx: Context, x: number, y: number): void {
    state.phase = "crashed";
    state.crashT = 0;
    state.crashX = state.shown + x;
    state.crashY = y;
    state.best = Math.max(state.best, state.score);
    ctx.sprites.hide(0);
    ctx.bgm.effect(psgVoice(2), CRASH);
}

function launch(ctx: Context): void {
    reset(Math.imul(state.t, 2654435761) >>> 0 || 1);
    state.phase = "flying";
    state.score = 0;
    state.x = 40;
    const start = state.cave.column(state.x >> 3);
    state.y = ((start.top + (PLAY_ROWS - start.bottom)) / 2) * 8 - SHIP_SIZE / 2;
    ctx.sprites.set(0, { x: state.x, y: state.y, pattern: 0, color: SHIP_COLORS });
}

// --- Drawing -----------------------------------------------------------------

/**
 * Builds the whole screen in the buffer. The name table is a ring: world
 * column c lives in slot c & 31, and 33 columns are written so the one coming
 * in on the right lands on the slot going out on the left, hidden by the mask.
 */
function compose(camera: number): void {
    const first = camera >> 3;
    for (let k = 0; k <= 32; ++k) {
        const column = state.cave.column(first + k);
        const slot = (first + k) & 31;
        for (let row = 0; row < PLAY_ROWS; ++row) frame.put(slot, row, cellOf(column, row));
    }

    if (state.phase === "crashed" && state.crashT < 60) {
        const cx = state.crashX >> 3, cy = state.crashY >> 3;
        for (let dy = -1; dy <= 1; ++dy) {
            for (let dx = -1; dx <= 1; ++dx) {
                const row = cy + dy;
                if (row >= 0 && row < PLAY_ROWS && (dx === 0 || dy === 0 || state.crashT > 12)) frame.put(cx + dx, row, CHAR.BURST);
            }
        }
    }

    // The score band, which the line interrupt holds still at x = 0.
    frame.fill(0, PLAY_ROWS, 32, 2, CHAR.EMPTY);
    frame.print(1, PLAY_ROWS, `SCORE ${pad(state.score)}   BEST ${pad(state.best)}`);
    const status = state.phase === "flying"
        ? `DIST ${pad(Math.floor(state.distance / 8))}   SPEED ${state.speed.toFixed(1)}`
        : state.phase === "crashed" ? "CRASHED" : "Z TO FLY  768 BYTES A FRAME";
    frame.print(1, PLAY_ROWS + 1, status);
}

function pad(n: number): string {
    return String(n).padStart(5, "0");
}

// --- The app -----------------------------------------------------------------

export const demo: App = {
    init(ctx: Context) {
        const { screen, scroll, sprites, bgm } = ctx;
        Object.assign(state, { phase: "title", score: 0, best: 0, t: 0, crashT: 0 });
        reset(1);

        screen.setMode("G3");               // SCREEN 4: SCREEN 2's characters, MSX2 sprites
        screen.setPalette(PALETTE);
        screen.setBackdrop(1);
        screen.setDisplayPage(0);
        screen.setDrawPage(0);

        // The cave slides a pixel at a time; the score does not.
        scroll.unsplit();
        scroll.set(0, 0);
        scroll.mask = true;
        scroll.split(HUD_TOP, { x: 0, y: 0 });

        defineCharacters(ctx);
        sprites.setSize(16);
        sprites.setPatternFromBitmap(0, SHIP_ART);
        sprites.hideAll();
        sprites.setActiveCount(1);

        compose(0);
        ctx.tiles.transfer(frame);

        bgm.play(THEME, { loop: true });
    },

    update(ctx: Context) {
        ++state.t;
        const { input } = ctx;
        switch (state.phase) {
            case "title":
                state.distance += 1;
                if (input.btnp(BUTTON.A)) launch(ctx);
                break;
            case "flying":
                fly(ctx);
                break;
            case "crashed":
                if (++state.crashT > 90 || (state.crashT > 30 && input.btnp(BUTTON.A))) {
                    state.phase = "title";
                    reset(1);
                }
                break;
        }
    },

    draw(ctx: Context) {
        const { tiles, scroll, sprites } = ctx;
        const camera = Math.floor(state.distance);
        animate(tiles, state.t);
        compose(camera);
        tiles.transfer(frame);              // the whole screen, every frame
        scroll.x = camera;
        state.shown = camera;
        if (state.phase === "flying") sprites.move(0, state.x, state.y);
    }
};
