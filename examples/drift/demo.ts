// DRIFT - the display as a window onto a plane, moved by registers.
//
// Nothing on screen here is redrawn to make it move. The picture sits in VRAM
// and the VDP is told where to start reading it: R23 for the line, the V9958's
// R26 and R27 for the column. That is a handful of register writes a frame
// where the blitter would have had to push the whole screen.
//
// Pages 2 and 3 are one plane, 512 pixels across and 256 down, because R25's
// SP2 lets the horizontal scroll run from an even page into the odd one after
// it and R23 wraps at 256 lines rather than at the screen's 212. The status
// bar lives on page 0 and holds still, which is the other half of the trick:
// the scroll is split into bands, and a line interrupt at the end of each band
// rewrites the registers for the next before the raster gets there.
//
// Two scenes, which X switches between:
//
//   VISTA  - a landscape in four layers, each band scrolled at its own speed.
//            Below them a lake gets a band on every one of its 36 lines. R23
//            points each of those lines at a reflection drawn upside down in
//            the 44 lines of the plane that never reach the screen, squeezed
//            to fit, and R26/R27 shakes each line a pixel or two either way.
//            That is 41 bands and 40 interrupts a frame.
//
//   ROAM   - a world 1024 pixels square, four times the plane. The plane is a
//            ring buffer onto it: as the camera moves, the tile column or row
//            about to come into view is written over the one that has just
//            left, on the far side of the wrap where nobody is looking. The
//            balloon and the beacons are sprites, and they are placed in
//            screen lines - `sprites` adds the vertical scroll back for you,
//            since R23 moves sprites along with the picture.
//
// Z toggles R25's MSK. A fine horizontal scroll shifts the picture right by up
// to seven pixels and shows the backdrop in the gap it leaves, so without the
// mask the left edge flutters as the scroll moves. The mask covers that column
// with the backdrop all the time.

import { BUTTON, SPRITE_FLAGS, type App, type Context, type ScrollBand } from "../../src/index.js";

// --- The plane -----------------------------------------------------------------

const PLANE_WIDTH = 512;
const PLANE_HEIGHT = 256;
/** Pages 2 and 3, left and right. Page 0 has the status bar and the sprite tables. */
const PLANE_PAGE = 2;
const PAGE_BYTES = 0x8000;
const LINE_BYTES = 128;

/** Screen lines the status bar takes. Everything below is the field. */
const HUD_HEIGHT = 20;
const SCREEN_HEIGHT = 212;
const FIELD_HEIGHT = SCREEN_HEIGHT - HUD_HEIGHT;

/** Colours the status bar is drawn in. Both scenes keep them. */
const HUD_PAPER = 1;
const HUD_INK = 15;

/** A plane's worth of colour indices, packed into VRAM a line at a time. */
const pixels = new Uint8Array(PLANE_WIDTH * PLANE_HEIGHT);

/** Copies plane lines [from, to) into pages 2 and 3, two pixels a byte. */
function upload(vram: Uint8Array, from = 0, to = PLANE_HEIGHT): void {
    for (let y = from; y < to; ++y) {
        for (let x = 0; x < PLANE_WIDTH; x += 2) {
            const page = PLANE_PAGE + (x >> 8);
            const at = page * PAGE_BYTES + y * LINE_BYTES + ((x & 255) >> 1);
            const i = y * PLANE_WIDTH + x;
            vram[at] = (pixels[i] << 4) | pixels[i + 1];
        }
    }
}

// --- Odds and ends -------------------------------------------------------------

type Rgb = readonly [number, number, number];

function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** A fixed pseudo-random value in [0, 1) for a pair of integers. */
function hash(x: number, y: number): number {
    let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function wrap(value: number, size: number): number {
    return ((value % size) + size) % size;
}

/** The shortest signed distance from `from` to `to` round a loop of `size`. */
function toward(from: number, to: number, size: number): number {
    const d = wrap(to - from, size);
    return d > size / 2 ? d - size : d;
}

/** A wave that fits the plane's width a whole number of times, so the picture tiles. */
function wave(x: number, cycles: number, phase = 0): number {
    return Math.sin((x / PLANE_WIDTH) * cycles * Math.PI * 2 + phase);
}

/** What R26 and R27 are given for a plane column, as `vdp.setHorizontalOffset` works it out. */
function registersFor(x: number): { coarse: number; fine: number } {
    const column = wrap(Math.round(x), PLANE_WIDTH);
    const coarse = ((column + 7) >> 3) & 0x3f;
    return { coarse, fine: (coarse * 8 - column) & 7 };
}

function hex(n: number, digits = 2): string {
    return n.toString(16).toUpperCase().padStart(digits, "0");
}

// --- Scenes --------------------------------------------------------------------

interface Scene {
    readonly name: string;
    readonly palette: readonly Rgb[];
    /** Draws the plane, sets up the bands and the sprites. */
    enter(ctx: Context): void;
    /** Moves things. `steering` is the joystick, or null when nobody is touching it. */
    update(ctx: Context, steering: { x: number; y: number } | null): void;
    /** The second line of the status bar. */
    readout(ctx: Context): string;
}

// --- VISTA -----------------------------------------------------------------------

// Plane lines, which in this scene are also screen lines: every band but the
// lake's shows the plane at y = 0 and moves only across.
const SKY_TOP = HUD_HEIGHT;
const MOUNTAINS_TOP = 72;
const HILLS_TOP = 112;
const GROUND_TOP = 152;
const LAKE_TOP = 176;
const LAKE_LINES = SCREEN_HEIGHT - LAKE_TOP;            // 36
/** Where the reflection is kept: the plane lines the screen never reaches. */
const REFLECTION_TOP = SCREEN_HEIGHT;
/** Lines of it that are the hills turned over. The rest is open water. */
const REFLECTION_LINES = GROUND_TOP - HILLS_TOP;        // 40

const DUSK: readonly Rgb[] = [
    [0, 0, 0],      // 0
    [0, 0, 2],      // 1  status bar
    [1, 0, 3],      // 2  sky, high
    [3, 1, 4],      // 3  sky
    [6, 3, 3],      // 4  horizon
    [7, 6, 3],      // 5  sun
    [3, 2, 4],      // 6  far range, lit
    [2, 1, 3],      // 7  far range, in shade; the road
    [0, 2, 1],      // 8  hills, dark
    [1, 4, 2],      // 9  hills, lit; grass
    [3, 2, 1],      // 10 earth
    [6, 5, 3],      // 11 road markings
    [0, 1, 2],      // 12 water, dark
    [2, 2, 5],      // 13 water, the sky in it
    [6, 4, 4],      // 14 glints
    [7, 7, 7]       // 15
];

const CAR_RIGHT = [
    "................",
    "................",
    "................",
    "................",
    "................",
    ".....######.....",
    "....#..#...#....",
    "...#...#....#...",
    ".##############.",
    "################",
    "################",
    "################",
    "..###......###..",
    ".#####....#####.",
    "..###......###..",
    "................"
];
const CAR_LEFT = CAR_RIGHT.map((row) => [...row].reverse().join(""));
const CAR_COLORS = [0, 0, 0, 0, 0, 15, 15, 15, 14, 14, 14, 14, 1, 1, 1, 0];
const CAR_X = 88;
const CAR_Y = 156;

function drawVista(): void {
    pixels.fill(0);
    const put = (x: number, y: number, c: number) => { pixels[y * PLANE_WIDTH + wrap(x, PLANE_WIDTH)] = c; };

    // Sky: three colours, crosshatched into each other over four lines.
    for (let y = SKY_TOP; y < MOUNTAINS_TOP; ++y) {
        for (let x = 0; x < PLANE_WIDTH; ++x) {
            const bayer = ((x & 1) * 2 + (y & 1) * 3) % 4 / 4;
            const t = (y - SKY_TOP) / (MOUNTAINS_TOP - SKY_TOP) * 2.2 + bayer * 0.35;
            put(x, y, t < 0.8 ? 2 : t < 1.6 ? 3 : 4);
        }
    }
    // A low sun, and clouds strung across it.
    for (let y = -12; y <= 12; ++y) {
        for (let x = -12; x <= 12; ++x) if (x * x + y * y <= 144) put(300 + x, 46 + y, 5);
    }
    const random = mulberry32(5);
    for (let i = 0; i < 14; ++i) {
        const cx = Math.floor(random() * PLANE_WIDTH);
        const cy = SKY_TOP + 8 + Math.floor(random() * 34);
        const width = 14 + Math.floor(random() * 30);
        for (let y = -3; y <= 2; ++y) {
            const span = width * Math.sqrt(1 - (y / 4) ** 2);
            for (let x = -span; x <= span; ++x) put(cx + Math.round(x), cy + y, y < 0 ? 4 : 3);
        }
    }

    // The far range. Its bottom six lines are one colour, because the hills'
    // band starts under them and scrolls at a different speed: whatever is
    // behind the hills has to be something that looks the same everywhere.
    const range = (x: number) => Math.max(6, 16 + 10 * wave(x, 2, 1) + 6 * wave(x, 5) + 3 * wave(x, 11, 2));
    for (let x = 0; x < PLANE_WIDTH; ++x) {
        const h = Math.round(range(x));
        const falling = range(x + 1) < range(x);
        for (let y = MOUNTAINS_TOP; y < HILLS_TOP; ++y) {
            const depth = y - (HILLS_TOP - h);
            let c = 4;
            if (depth >= 0) c = h > 27 && depth < 2 ? 15 : falling && y < HILLS_TOP - 6 ? 7 : 6;
            put(x, y, c);
        }
    }

    // The hills, and trees along the ridge.
    const hills = (x: number) => Math.round(Math.max(6, Math.min(38, 20 + 8 * wave(x, 3) + 5 * wave(x, 7, 1) + 2 * wave(x, 17))));
    for (let x = 0; x < PLANE_WIDTH; ++x) {
        const h = hills(x);
        for (let y = HILLS_TOP; y < GROUND_TOP; ++y) {
            const depth = y - (GROUND_TOP - h);
            put(x, y, depth < 0 ? 6 : depth < 3 ? 9 : 8);
        }
    }
    for (let tree = 0; tree < PLANE_WIDTH; tree += 16) {
        if (hash(tree, 1) < 0.35) continue;
        const x = tree + Math.floor(hash(tree, 2) * 12);
        const base = GROUND_TOP - hills(x) + 2;
        const tall = 7 + Math.floor(hash(tree, 3) * 6);
        for (let y = 0; y < tall; ++y) {
            const half = Math.floor((y + 1) / 2.5);
            // A tree poking above line 112 would be cut off and left behind by
            // the far range's band, which moves at half the speed.
            if (base - tall + y < HILLS_TOP) continue;
            for (let dx = -half; dx <= half; ++dx) put(x + dx, base - tall + y, 8);
        }
    }

    // The near shore: grass, a fence, the road, a strip of earth.
    for (let x = 0; x < PLANE_WIDTH; ++x) {
        for (let y = GROUND_TOP; y < LAKE_TOP; ++y) {
            let c = hash(x, y) < 0.2 ? 8 : 9;
            if (y >= 157 && y <= 163 && (x % 16 === 0 || y === 158 || y === 161)) c = 10;
            if (y >= 164 && y < 172) c = y >= 167 && y <= 168 && x % 32 < 16 ? 11 : 7;
            if (y >= 172) c = 10;
            put(x, y, c);
        }
    }

    // The reflection: the hills upside down, in water colours, kept in the
    // plane's last 44 lines. The lake's bands point R23 at it one line at a time.
    for (let k = 0; k < PLANE_HEIGHT - REFLECTION_TOP; ++k) {
        for (let x = 0; x < PLANE_WIDTH; ++x) {
            let c = 12;
            if (k < REFLECTION_LINES) {
                const above = pixels[(GROUND_TOP - 1 - k) * PLANE_WIDTH + x];
                c = above === 6 ? 13 : 12;
                if (c === 13 && hash(x >> 2, k) < 0.06) c = 14;
            }
            put(x, REFLECTION_TOP + k, c);
        }
    }
}

function vista(): Scene {
    let camera = 0;
    let speed = 1;
    let t = 0;
    let sky: ScrollBand, mountains: ScrollBand, hills: ScrollBand, ground: ScrollBand;
    const lake: ScrollBand[] = [];

    return {
        name: "VISTA",
        palette: DUSK,

        enter({ scroll, sprites, bios }) {
            drawVista();
            upload(bios.system.vdp.vram);

            sky = scroll.split(SKY_TOP, { page: PLANE_PAGE, y: 0 });
            mountains = scroll.split(MOUNTAINS_TOP, { page: PLANE_PAGE, y: 0 });
            hills = scroll.split(HILLS_TOP, { page: PLANE_PAGE, y: 0 });
            ground = scroll.split(GROUND_TOP, { page: PLANE_PAGE, y: 0 });
            // One band per line of lake. Each points its line at a line of the
            // reflection: 40 lines of it squeezed into 36, so it reads as a
            // surface seen at an angle rather than a mirror stood on end.
            lake.length = 0;
            for (let i = 0; i < LAKE_LINES; ++i) {
                const line = LAKE_TOP + i;
                const source = REFLECTION_TOP + Math.floor((i * REFLECTION_LINES) / LAKE_LINES);
                lake.push(scroll.split(line, { page: PLANE_PAGE, y: source - line }));
            }

            sprites.setPatternFromBitmap(0, CAR_RIGHT);
            sprites.setPatternFromBitmap(4, CAR_LEFT);
        },

        update({ sprites }, steering) {
            ++t;
            if (steering) speed = Math.max(-4, Math.min(4, speed + steering.x * 0.08));
            camera = wrap(camera + speed, PLANE_WIDTH * 16);

            // Each layer at its own fraction of the camera. The further away,
            // the slower - which is all parallax is.
            sky.x = camera / 16;
            mountains.x = camera / 4;
            hills.x = camera / 2;
            ground.x = camera;
            for (let i = 0; i < lake.length; ++i) {
                // Nearer lines ripple further, and the ripple travels down.
                const reach = 0.6 + i / 14;
                lake[i].x = hills.x + Math.round(Math.sin(t * 0.07 - i * 0.6) * reach);
            }

            const bounce = Math.abs(speed) > 0.05 && (t >> 2) % 3 === 0 ? 1 : 0;
            sprites.set(0, { x: CAR_X, y: CAR_Y - bounce, pattern: speed < 0 ? 4 : 0, color: CAR_COLORS });
        },

        readout({ scroll }) {
            const { coarse, fine } = registersFor(ground.x);
            return `BANDS ${scroll.bands.length}  ROAD ${hex(wrap(Math.round(ground.x), PLANE_WIDTH), 3)}  R26 ${hex(coarse)} R27 ${fine}`;
        }
    };
}

// --- ROAM ------------------------------------------------------------------------

const TILE = 8;
export const WORLD_TILES = 128;
const WORLD = WORLD_TILES * TILE;                       // 1024 pixels round
const PLANE_COLUMNS = PLANE_WIDTH / TILE;               // 64
const PLANE_ROWS = PLANE_HEIGHT / TILE;                 // 32

const ISLES: readonly Rgb[] = [
    [0, 0, 0],      // 0
    [0, 0, 2],      // 1  status bar
    [0, 1, 4],      // 2  deep water
    [1, 2, 5],      // 3  water        } swapped back and forth
    [2, 4, 6],      // 4  wave crests  } to make the sea move
    [6, 6, 4],      // 5  sand
    [2, 5, 1],      // 6  grass
    [1, 3, 1],      // 7  grass, darker
    [0, 2, 0],      // 8  forest
    [3, 2, 1],      // 9  earth
    [4, 4, 4],      // 10 rock
    [2, 2, 3],      // 11 rock, in shade
    [7, 2, 2],      // 12 flowers, the beacons
    [0, 0, 1],      // 13 shadow
    [7, 6, 1],      // 14 balloon
    [7, 7, 7]       // 15
];

/** 8x8 tiles, one hex digit a pixel. */
const TILES: Record<string, readonly string[]> = {
    deep: ["22222222", "22222222", "22232222", "22222222", "22222222", "22222223", "22222222", "22222222"],
    water: ["33333333", "33343333", "33433333", "33333333", "33333333", "33333343", "33333433", "33333333"],
    shore: ["44333333", "34433334", "33333344", "33333333", "44333333", "33443333", "33333333", "33334433"],
    sand: ["55555555", "55595555", "55555555", "55555595", "55555555", "59555555", "55555555", "55555555"],
    grass: ["66666666", "66676666", "66666666", "66666676", "66666666", "67666666", "66666666", "66666666"],
    flowers: ["66666666", "66c66666", "66666666", "66666c66", "66666666", "6c666666", "66666666", "66666c66"],
    forest: ["66688666", "66888866", "68888886", "88888888", "66898666", "88896888", "88888888", "68888886"],
    rock: ["6a6aaa66", "aaaaaaa6", "aabaaaaa", "aaabaaba", "aaaaaaaa", "abaaaaab", "aaaaabaa", "6aaaaaa6"],
    peak: ["aaaffaaa", "aaffffaa", "affffbba", "affbbbba", "aabbbbba", "abbbbbbb", "abbbabbb", "aabbbbba"]
};
const TILE_NAMES = Object.keys(TILES);

/** Each tile packed the way GRAPHIC4 stores it: 8 rows of 4 bytes. */
export const TILE_BYTES = TILE_NAMES.map((name) => {
    const rows = TILES[name];
    const bytes = new Uint8Array(32);
    for (let y = 0; y < 8; ++y) {
        for (let x = 0; x < 8; x += 2) {
            bytes[y * 4 + (x >> 1)] = (parseInt(rows[y][x], 16) << 4) | parseInt(rows[y][x + 1], 16);
        }
    }
    return bytes;
});

/** The world, as a tile index per cell. Seamless: it wraps at both edges. */
export function makeWorld(seed: number): Uint8Array {
    const random = mulberry32(seed);
    // Value noise on lattices that divide the world, so every octave wraps.
    const octaves = [32, 16, 8, 4].map((cell) => {
        const n = WORLD_TILES / cell;
        const values = Float32Array.from({ length: n * n }, () => random());
        return { cell, n, values };
    });
    const smooth = (t: number) => t * t * (3 - 2 * t);
    const noise = (x: number, y: number) => {
        let total = 0;
        let weight = 0;
        let amplitude = 1;
        for (const { cell, n, values } of octaves) {
            const gx = x / cell, gy = y / cell;
            const x0 = Math.floor(gx), y0 = Math.floor(gy);
            const fx = smooth(gx - x0), fy = smooth(gy - y0);
            const at = (i: number, j: number) => values[wrap(j, n) * n + wrap(i, n)];
            const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * fx;
            const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * fx;
            total += (top + (bottom - top) * fy) * amplitude;
            weight += amplitude;
            amplitude *= 0.5;
        }
        return total / weight;
    };

    const index = (name: string) => TILE_NAMES.indexOf(name);
    const world = new Uint8Array(WORLD_TILES * WORLD_TILES);
    for (let y = 0; y < WORLD_TILES; ++y) {
        for (let x = 0; x < WORLD_TILES; ++x) {
            const h = noise(x, y);
            const name = h < 0.42 ? "deep" : h < 0.49 ? "water" : h < 0.52 ? "shore" : h < 0.56 ? "sand"
                : h < 0.66 ? (hash(x, y) < 0.15 ? "flowers" : "grass")
                : h < 0.74 ? "forest" : h < 0.8 ? "rock" : "peak";
            world[y * WORLD_TILES + x] = index(name);
        }
    }
    return world;
}

const BALLOON = [
    ".....######.....",
    "...##########...",
    "..############..",
    ".##############.",
    ".##############.",
    "################",
    "################",
    ".##############.",
    ".##############.",
    "..############..",
    "...##########...",
    ".....#....#.....",
    "......#..#......",
    "......####......",
    "......####......",
    "................"
];
const BALLOON_COLORS = [14, 14, 12, 14, 14, 12, 14, 14, 12, 14, 14, 9, 9, 9, 9, 0];
const SHADOW = [
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "....########....",
    "..############..",
    "..############..",
    "....########....",
    "................",
    "................"
];
const BEACON = [
    "................",
    "................",
    "................",
    "................",
    "................",
    "......##........",
    "......####......",
    "......######....",
    "......####......",
    "......##........",
    "......#.........",
    "......#.........",
    "....#####.......",
    "...#######......",
    "................",
    "................"
];
const BEACONS = 8;
export const WORLD_SEED = 1988;

function roam(): Scene {
    const world = makeWorld(WORLD_SEED);
    let vram: Uint8Array;
    // The balloon, in world pixels, and the camera's top-left corner. Neither
    // is wrapped: the world is looked up modulo its size, and so is the plane.
    let x = 300, y = 520, vx = 0, vy = 0;
    let cameraX = 0, cameraY = 0;
    let camX = 0, camY = 0;                 // the camera, to the pixel
    let t = 0;
    let field: ScrollBand;
    // The tiles the plane holds: world columns [left, left + 64), rows [top, top + 32).
    let left = 0, top = 0;
    let streamed = 0;
    const beacons: Array<{ x: number; y: number }> = [];

    const tileAt = (column: number, row: number) =>
        world[wrap(row, WORLD_TILES) * WORLD_TILES + wrap(column, WORLD_TILES)];

    /** Writes one world tile into the plane cell it maps to. */
    const drawTile = (column: number, row: number) => {
        const px = (column & (PLANE_COLUMNS - 1)) * TILE;
        const py = (row & (PLANE_ROWS - 1)) * TILE;
        const at = (PLANE_PAGE + (px >> 8)) * PAGE_BYTES + py * LINE_BYTES + ((px & 255) >> 1);
        const bytes = TILE_BYTES[tileAt(column, row)];
        for (let line = 0; line < TILE; ++line) {
            vram.set(bytes.subarray(line * 4, line * 4 + 4), at + line * LINE_BYTES);
        }
        ++streamed;
    };

    const drawColumn = (column: number) => { for (let r = top; r < top + PLANE_ROWS; ++r) drawTile(column, r); };
    const drawRow = (row: number) => { for (let c = left; c < left + PLANE_COLUMNS; ++c) drawTile(c, row); };

    /**
     * Keeps the tiles the camera can see in the plane. The plane is a ring:
     * a column coming in on the right is written over the one that has just
     * gone out on the left, which is on the far side of the wrap from where
     * the screen is looking - so the seam is never seen being sewn.
     */
    const stream = (all: boolean) => {
        const needLeft = Math.floor(camX / TILE);
        const needRight = Math.floor((camX + 255) / TILE);
        const needTop = Math.floor(camY / TILE);
        const needBottom = Math.floor((camY + FIELD_HEIGHT - 1) / TILE);

        if (all) {
            left = needLeft - 16;
            top = needTop - 3;
            for (let r = top; r < top + PLANE_ROWS; ++r) drawRow(r);
            return;
        }
        while (needLeft < left) drawColumn(--left);
        while (needRight >= left + PLANE_COLUMNS) { drawColumn(left + PLANE_COLUMNS); ++left; }
        while (needTop < top) drawRow(--top);
        while (needBottom >= top + PLANE_ROWS) { drawRow(top + PLANE_ROWS); ++top; }
    };

    const follow = () => {
        cameraX = x - 128;
        cameraY = y - FIELD_HEIGHT / 2;
        camX = Math.round(cameraX);
        camY = Math.round(cameraY);
    };

    return {
        name: "ROAM",
        palette: ISLES,

        enter({ scroll, sprites, bios }) {
            vram = bios.system.vdp.vram;
            follow();
            stream(true);
            field = scroll.split(HUD_HEIGHT, { page: PLANE_PAGE });

            sprites.setPatternFromBitmap(0, BALLOON);
            sprites.setPatternFromBitmap(4, SHADOW);
            sprites.setPatternFromBitmap(8, BEACON);
            if (beacons.length === 0) {
                const random = mulberry32(7);
                for (let i = 0; i < BEACONS; ++i) beacons.push({ x: random() * WORLD, y: random() * WORLD });
            }
        },

        update({ screen, sprites }, steering) {
            ++t;
            // Nobody at the stick: drift on a slow figure of eight round the world.
            const want = steering ?? {
                x: Math.cos(t / 240) * 0.8,
                y: Math.sin(t / 120) * 0.8
            };
            vx = (vx + want.x * 0.18) * 0.95;
            vy = (vy + want.y * 0.18) * 0.95;
            x += vx;
            y += vy;

            // The camera eases after the balloon rather than being nailed to it.
            cameraX += (x - 128 - cameraX) * 0.08;
            cameraY += (y - FIELD_HEIGHT / 2 - cameraY) * 0.08;
            camX = Math.round(cameraX);
            camY = Math.round(cameraY);

            streamed = 0;
            stream(false);

            // Plane line at the top of the screen is the world line at the top
            // of the field, less the lines the status bar sits over.
            field.x = camX;
            field.y = camY - HUD_HEIGHT;

            // The sea moves by swapping two registers, not by touching the tiles.
            if (t % 24 === 0) {
                const [a, b] = (t / 24) % 2 ? [ISLES[4], ISLES[3]] : [ISLES[3], ISLES[4]];
                screen.setColor(3, a[0], a[1], a[2]);
                screen.setColor(4, b[0], b[1], b[2]);
            }

            // Sprites go at screen lines, and `sprites` adds R23 back. The
            // shadow lags the balloon on the ground, as a sun from the top left
            // would have it.
            const bob = Math.round(Math.sin(t / 20) * 2);
            const sx = Math.round(x - camX) - 8;
            const sy = Math.round(y - camY) + HUD_HEIGHT - 8;
            sprites.set(0, { x: sx, y: sy + bob, pattern: 0, color: BALLOON_COLORS });
            sprites.set(1, { x: sx + 5, y: sy + 8, pattern: 4, color: 13 });

            for (let i = 0; i < beacons.length; ++i) {
                const bx = Math.round(toward(camX, beacons[i].x, WORLD)) - 8;
                const by = Math.round(toward(camY, beacons[i].y, WORLD)) + HUD_HEIGHT - 8;
                if (bx <= -16 || bx >= 256 || by < HUD_HEIGHT || by > SCREEN_HEIGHT) {
                    sprites.hide(2 + i);
                    continue;
                }
                // EC shifts a sprite 32 pixels left, which is how one slides in
                // from the left edge instead of popping into view.
                const early = bx < 0;
                sprites.set(2 + i, {
                    x: early ? bx + 32 : bx, y: by, pattern: 8,
                    color: (t >> 4) % 2 ? 12 : 15,
                    flags: early ? SPRITE_FLAGS.EARLY_CLOCK : 0
                });
            }
        },

        readout() {
            const { coarse, fine } = registersFor(field.x);
            const r23 = wrap(field.y, 256);
            return `X ${hex(wrap(camX, WORLD), 3)} Y ${hex(wrap(camY, WORLD), 3)}  R23 ${hex(r23)} R26 ${hex(coarse)} R27 ${fine}  +${streamed}`;
        }
    };
}

// --- The machine -----------------------------------------------------------------

/** Frames without a touch before the scenes start changing on their own. */
const IDLE = 60 * 20;

const scenes: Scene[] = [];
let current = 0;
let idle = 0;
let shown = "";

function enter(ctx: Context, index: number): void {
    const { scroll, sprites, screen } = ctx;
    current = index;
    const scene = scenes[current];

    sprites.hideAll();
    scroll.unsplit();
    // The top band is the status bar: page 0, held still.
    scroll.split(0, { x: 0, y: 0, page: 0 });
    screen.setPalette(scene.palette);
    scene.enter(ctx);
    shown = "";
}

function hud({ gfx, scroll }: Context, line2: string): void {
    const line1 = `DRIFT  ${scenes[current].name.padEnd(8)}      MASK ${scroll.mask ? "ON " : "OFF"}`;
    const text = line1 + "\n" + line2;
    if (text === shown) return;
    shown = text;
    gfx.now.fillRect(0, 0, 256, HUD_HEIGHT, HUD_PAPER);
    gfx.now.text(4, 2, line1, HUD_INK);
    gfx.now.text(4, 11, line2, HUD_INK);
}

export const demo: App = {
    init(ctx) {
        const { screen, scroll, gfx } = ctx;
        screen.setMode("G4");
        screen.setBackdrop(0);
        gfx.now.clear(HUD_PAPER);           // page 0: the status bar's page

        scroll.wide = true;                 // pages 2 and 3, side by side
        scroll.mask = true;

        scenes.length = 0;
        scenes.push(vista(), roam());
        idle = 0;
        enter(ctx, 0);
    },

    update(ctx) {
        const { input, scroll } = ctx;
        if (input.btnp(BUTTON.B)) { enter(ctx, (current + 1) % scenes.length); idle = 0; }
        if (input.btnp(BUTTON.A)) { scroll.mask = !scroll.mask; idle = 0; }

        const axis = input.axis();
        const touched = axis.x !== 0 || axis.y !== 0;
        idle = touched ? 0 : idle + 1;
        if (idle > 0 && idle % IDLE === 0) enter(ctx, (current + 1) % scenes.length);

        scenes[current].update(ctx, touched ? axis : null);
    },

    draw(ctx) {
        hud(ctx, scenes[current].readout(ctx));
    }
};
