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

import { compile, opllVoice, psgVoice, rhythmVoice, type App, type Context } from "../../src/index.js";

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

function project(vertex: readonly [number, number, number], yaw: number, pitch: number, scale: number): Projected {
    const [vx, vy, vz] = vertex;

    // Yaw about Y, then pitch about X.
    const sx = vx * Math.cos(yaw) + vz * Math.sin(yaw);
    const sz = vz * Math.cos(yaw) - vx * Math.sin(yaw);
    const sy = vy * Math.cos(pitch) - sz * Math.sin(pitch);
    const dz = sz * Math.cos(pitch) + vy * Math.sin(pitch) + CAMERA;

    const k = FOCAL / dz;
    return {
        x: CENTRE_X + sx * scale * k,
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

const state = { time: 0 };

// --- Drawing -----------------------------------------------------------------

const HORIZON = 118;

/** A ground plane running to a vanishing point, sliding towards the eye. */
function floor(gfx: Context["gfx"], time: number): void {
    // Lines away, converging on the vanishing point. Drawn first, so the
    // crossing lines sit on top of them.
    for (let i = -12; i <= 12; ++i) {
        gfx.now.line(CENTRE_X, HORIZON, CENTRE_X + i * 96, HEIGHT - 1, DEPTH_LOW + 1);
    }

    // Lines across, spaced by 1/z so they crowd towards the horizon, and
    // scrolling by the fraction of a step the eye has travelled.
    const offset = time % 1;
    for (let i = 0; i < 15; ++i) {
        const z = i + offset + 2.4;
        const y = Math.round(HORIZON + 208 / z);
        if (y >= HEIGHT || y <= HORIZON + 1) continue;
        gfx.now.hline(0, y, WIDTH, depthColor(Math.min(1, 2.4 / z)));
    }
}

function solid(gfx: Context["gfx"], time: number): void {
    const yaw = time * 0.7;
    const pitch = Math.sin(time * 0.41) * 0.8;
    const scale = 0.78 + 0.14 * Math.sin(time * 0.9);

    const points = VERTICES.map((vertex) => project(vertex, yaw, pitch, scale));

    // Far edges first, so near ones draw over them - a painter's sort, which is
    // all a wireframe needs.
    const order = EDGES.map((edge, index) => ({ index, depth: (points[edge[0]].depth + points[edge[1]].depth) / 2 }))
        .sort((a, b) => a.depth - b.depth);

    for (const { index, depth } of order) {
        const [a, b] = EDGES[index];
        gfx.now.line(
            Math.round(points[a].x), Math.round(points[a].y),
            Math.round(points[b].x), Math.round(points[b].y),
            depthColor(depth)
        );
    }
}

export const demo: App = {
    init({ screen, gfx, sprites, bgm }: Context) {
        state.time = 0;

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

    draw({ gfx, screen }: Context) {
        // Redrawn whole, every frame, on the page that is not being shown.
        gfx.now.clear(1);
        floor(gfx, state.time * 1.6);
        solid(gfx, state.time);

        gfx.now.text(8, 6, "W I R E", 15);
        gfx.now.text(8, 18, "SCREEN 7 - 512x212 - 16 OF 512 COLOURS", 9);
        gfx.now.text(8, 28, `${EDGES.length} EDGES, SOFTWARE, 60 FPS, TWO PAGES`, 7);
        // The grid runs down to the bottom edge, so the caption gets its own
        // strip to sit on.
        gfx.now.fillRect(0, HEIGHT - 16, WIDTH, 16, 1);
        gfx.now.text(8, HEIGHT - 12, "FM: FOUR VOICES + PSG BASS + RHYTHM", 6);

        screen.flip();
    }
};
