// WIRE - a demo rather than a game, to see what the machine looks like when it
// is asked for its best.
//
// SCREEN 7 is the V9938's widest bitmap mode: 512x212 in 16 colours out of 512,
// two 64KB pages to flip between. Line art at that width is more pixels than
// the blitter could ever push in a frame, so this draws in software and flips -
// the point being that with TypeScript in the CPU's seat, that is free. The
// blitter is for when you want its pace; this is when you do not.
//
// Everything moving here is drawn every frame. Nothing is a sprite.
//
// X switches between the two ways of drawing it. In software the picture is
// rebuilt every frame for nothing. Through the blitter it is rebuilt at the
// speed the V9938 can actually clear a page and pull 512-pixel lines across
// it, which is the same picture at a fraction of the rate - and the point of
// having the choice.
//
// Either way it is drawn on the page nobody is looking at and swapped in when
// it is whole. That is what the second page is for.

import { BUTTON, compile, opllVoice, psgVoice, rhythmVoice, type App, type Context } from "../../src/index.js";

const WIDTH = 512;
const HEIGHT = 212;
const CENTRE_X = 256;
const CENTRE_Y = 96;

/** Colour 1 is the ground, 2..15 a ramp from far to near. */
const DEPTH_LOW = 2;
const DEPTH_HIGH = 15;

// --- The solid ---------------------------------------------------------------

const PHI = (1 + Math.sqrt(5)) / 2;

/** An icosahedron: twelve vertices, and thirty edges found by measuring. */
const VERTICES: Array<[number, number, number]> = [];
for (const s of [1, -1]) {
    for (const t of [1, -1]) {
        VERTICES.push([0, s, t * PHI], [s, t * PHI, 0], [s * PHI, 0, t]);
    }
}

const EDGES: Array<[number, number]> = [];
for (let a = 0; a < VERTICES.length; ++a) {
    for (let b = a + 1; b < VERTICES.length; ++b) {
        const [ax, ay, az] = VERTICES[a];
        const [bx, by, bz] = VERTICES[b];
        // Edge length is exactly 2 for these coordinates; anything longer is a
        // diagonal across the solid.
        if (Math.hypot(ax - bx, ay - by, az - bz) < 2.2) EDGES.push([a, b]);
    }
}

const CAMERA = 6;       // distance from the eye to the origin
const FOCAL = 260;      // larger is a longer lens
const RADIUS = 1.9;

interface Projected {
    x: number;
    y: number;
    /** Depth, 0 far to 1 near, for choosing a colour. */
    depth: number;
}

/**
 * `stretch` is how many horizontal pixels make up one pixel's worth of height.
 * In SCREEN 7 that is two, because the pixels are half as wide as they are
 * tall - project without it and a sphere comes out an egg.
 */
function project(
    vertex: readonly [number, number, number],
    yaw: number, pitch: number, scale: number, stretch: number
): Projected {
    const [vx, vy, vz] = vertex;

    // Yaw about Y, then pitch about X.
    const sx = vx * Math.cos(yaw) + vz * Math.sin(yaw);
    const sz = vz * Math.cos(yaw) - vx * Math.sin(yaw);
    const sy = vy * Math.cos(pitch) - sz * Math.sin(pitch);
    const dz = sz * Math.cos(pitch) + vy * Math.sin(pitch) + CAMERA;

    const k = FOCAL / dz;
    return {
        x: CENTRE_X + sx * scale * k * stretch,
        y: CENTRE_Y + sy * scale * k,
        depth: Math.max(0, Math.min(1, (CAMERA + RADIUS - dz) / (RADIUS * 2)))
    };
}

function depthColor(depth: number): number {
    return DEPTH_LOW + Math.round(depth * (DEPTH_HIGH - DEPTH_LOW));
}

// --- Music -------------------------------------------------------------------

const SCORE = compile([
    // Three FM voices holding the chords, one arpeggiating over them.
    { voice: opllVoice(0), mml: "t100 @8 v12 l1 o3 [d a- f c]2" },
    { voice: opllVoice(1), mml: "t100 @8 v10 l1 o4 [f c a e]2" },
    { voice: opllVoice(2), mml: "t100 @11 v10 l1 o4 [a f >c< g]2" },
    { voice: opllVoice(3), mml: "t100 @12 v9 l16 o5 [[dfad]4 [ceac]4 [fac f]4 [ceg c]4]2" },
    // The PSG takes the bass, where the FM chip is weakest.
    { voice: psgVoice(0), mml: "t100 v11 q6 l4 o2 [dddd aaaa ffff cccc]2" },
    { voice: rhythmVoice(), mml: "t100 v8 l4 [{cg} g {dg} g]8" }
]);

// --- State -------------------------------------------------------------------

/**
 * The subset of drawing both paths share. `gfx` queues for the blitter and
 * `gfx.now` writes VRAM directly, but the scene is written once against this
 * and handed whichever one is in charge.
 */
interface Painter {
    clear(color: number): void;
    hline(x: number, y: number, width: number, color: number): void;
    line(x0: number, y0: number, x1: number, y1: number, color: number): void;
    fillRect(x: number, y: number, width: number, height: number, color: number): void;
    text(x: number, y: number, text: string, color?: number, background?: number): void;
}

const state = {
    time: 0,
    /** False draws in software every frame; true hands the scene to the blitter. */
    blitter: false,
    /** Frame the image in progress was started on, for measuring the rate. */
    startedAt: 0,
    /** True once a whole image has been timed, so the first one claims nothing. */
    timed: false,
    /** How many frames the last completed image took. */
    cost: 1
};

// --- Drawing -----------------------------------------------------------------

const HORIZON = 118;

/** A ground plane running to a vanishing point, sliding towards the eye. */
function floor(paint: Painter, time: number): void {
    // Lines away, converging on the vanishing point. Drawn first, so the
    // crossing lines sit on top of them.
    for (let i = -12; i <= 12; ++i) {
        paint.line(CENTRE_X, HORIZON, CENTRE_X + i * 96, HEIGHT - 1, DEPTH_LOW + 1);
    }

    // Lines across, spaced by 1/z so they crowd towards the horizon, and
    // scrolling by the fraction of a step the eye has travelled.
    const offset = time % 1;
    for (let i = 0; i < 15; ++i) {
        const z = i + offset + 2.4;
        const y = Math.round(HORIZON + 208 / z);
        if (y >= HEIGHT || y <= HORIZON + 1) continue;
        paint.hline(0, y, WIDTH, depthColor(Math.min(1, 2.4 / z)));
    }
}

function solid(paint: Painter, time: number, stretch: number): void {
    const yaw = time * 0.7;
    const pitch = Math.sin(time * 0.41) * 0.8;
    const scale = 0.62 + 0.11 * Math.sin(time * 0.9);

    const points = VERTICES.map((vertex) => project(vertex, yaw, pitch, scale, stretch));

    // Far edges first, so near ones draw over them - a painter's sort, which is
    // all a wireframe needs.
    const order = EDGES.map((edge, index) => ({ index, depth: (points[edge[0]].depth + points[edge[1]].depth) / 2 }))
        .sort((a, b) => a.depth - b.depth);

    for (const { index, depth } of order) {
        const [a, b] = EDGES[index];
        paint.line(
            Math.round(points[a].x), Math.round(points[a].y),
            Math.round(points[b].x), Math.round(points[b].y),
            depthColor(depth)
        );
    }
}

/** One whole picture, drawn by whichever painter is in charge. */
function scene(paint: Painter, time: number, stretch: number): void {
    paint.clear(1);
    floor(paint, time * 1.6);
    solid(paint, time, stretch);

    const rate = state.timed ? `${(60 / state.cost).toFixed(1)} IMAGES/SEC` : "TIMING";
    paint.text(8, 6, "W I R E", 15);
    paint.text(8, 18, "SCREEN 7 - 512x212 - 16 OF 512 COLOURS", 9);
    paint.text(8, 28, state.blitter
        ? `VDP BLITTER - ${rate} - X FOR SOFTWARE`
        : "SOFTWARE - 60 IMAGES/SEC - X FOR THE BLITTER", state.blitter ? 11 : 7);

    // The grid runs down to the bottom edge, so the caption gets its own strip.
    paint.fillRect(0, HEIGHT - 16, WIDTH, 16, 1);
    paint.text(8, HEIGHT - 12, "FM: FOUR VOICES + PSG BASS + RHYTHM", 6);
}

export const demo: App = {
    init({ screen, gfx, sprites, bgm }: Context) {
        state.time = 0;
        state.blitter = false;
        state.startedAt = 0;
        state.timed = false;
        state.cost = 1;

        screen.setMode("G6");           // SCREEN 7: 512x212, 16 of 512 colours
        screen.setBackdrop(1);
        screen.setColor(1, 0, 0, 1);
        // A ramp from a far, cold blue to a near, warm white.
        for (let i = DEPTH_LOW; i <= DEPTH_HIGH; ++i) {
            const t = (i - DEPTH_LOW) / (DEPTH_HIGH - DEPTH_LOW);
            // Blue far, cyan through the middle, white near: red arrives last.
            screen.setColor(i, Math.round(t * t * 7), Math.round(t * 7), Math.round(2 + t * 5));
        }

        sprites.setEnabled(false);      // nothing here is a sprite
        screen.useDoubleBuffer();
        gfx.now.clear(1);

        bgm.play(SCORE, { loop: true });
    },

    update() {
        state.time += 1 / 60;
    },

    draw({ gfx, screen, input, frame }: Context) {
        if (input.btnp(BUTTON.B)) {
            state.blitter = !state.blitter;
            gfx.abandon();              // drop whatever the old path left queued
            state.timed = false;
            state.startedAt = frame;
        }

        const stretch = 1 / screen.pixelAspect;

        if (!state.blitter) {
            // Rebuilt whole, every frame, on the page that is not being shown.
            scene(gfx.now, state.time, stretch);
            screen.flip();
            state.cost = 1;
            return;
        }

        // Nothing to do until the chip has finished the picture it is on.
        if (gfx.busy) return;

        // Show the finished page, then start the next one on the one it just
        // replaced. Both paths draw on the page nobody is looking at: this is
        // why the machine has two, and why MSX programs used them.
        screen.flip();

        if (state.timed) state.cost = Math.max(1, frame - state.startedAt);
        state.startedAt = frame;
        scene(gfx, state.time, stretch);
        // Marked only now, so the first picture reads TIMING rather than
        // claiming the one frame it has not yet taken.
        state.timed = true;
    }
};
