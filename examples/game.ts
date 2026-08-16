// INK - a small game built out of what this machine is unusual for.
//
// The framebuffer is persistent, so the paint you lay down *is* the game state.
// The blitter is slow, so paint arrives over several frames and you have to lay
// it where a drifter is going rather than where it is. Sprites cost nothing, so
// everything that moves is one.
//
// Arrows or WASD to fly, Z to spray, X to start.

import {
    BUTTON, compile, opllVoice, psgVoice, rhythmVoice, type App, type Context
} from "../src/index.js";

// --- The machine's fixed bits ------------------------------------------------

const WIDTH = 256;
const HEIGHT = 212;
const BAR = 10;                     // status bar along the top
const PLAYER_SPRITE = 0;
const PLAYER_PATTERN = 0;
const DRIFTER_PATTERN = 4;          // 16x16 patterns come in fours
const MAX_DRIFTERS = 7;             // eight sprites to a scanline, and one is the player

/** Palette entries at or above this count as painted. */
const INK = 8;

const PLAYER_ART = [
    ".......##.......", "......####......", "......####......", ".....######.....",
    ".....######.....", "....########....", "....##.##.##....", "...####..####...",
    "...###....###...", "..####....####..", "..###......###..", ".####......####.",
    ".##..........##.", "###..........###", "##............##", "................"
];

const DRIFTER_ART = [
    "................", "...##########...", "..############..", ".####..##..####.",
    "###....##....###", "##.....##.....##", "##..##########..", "##..##......##..",
    "##..##......##..", "##..##########..", "##.....##.....##", "###....##....###",
    ".####..##..####.", "..############..", "...##########...", "................"
];

// --- Music -------------------------------------------------------------------

const THEME = compile([
    { voice: psgVoice(0), mml: "t150 v12 q7 l8 o5 [eagaece4 fagafcf4 egecgec4 dgfgdbg4]2" },
    { voice: psgVoice(1), mml: "t150 v10 q6 l4 o2 [aaaa ffff cccc gggg]2" },
    { voice: opllVoice(0), mml: "t150 @8 v11 l1 o3 [afcg]2" },
    { voice: rhythmVoice(), mml: "t150 v11 l8 [{cg}g{dg}g{cg}g{dg}g]8" }
]);

const FANFARE = compile([
    { voice: psgVoice(0), mml: "t150 v13 q8 l16 o5 cegc>e<g>c8" },
    { voice: opllVoice(0), mml: "t150 @11 v12 l4 o4 c" }
]);

const KNELL = compile([
    { voice: psgVoice(0), mml: "t100 v13 q8 l8 o4 g f e- c4" },
    { voice: opllVoice(0), mml: "t100 @6 v12 l2 o3 c" }
]);

const SPRAY = "t150 v14 q8 l32 o6 >c< bagfedc";
const POP = "t150 v15 q8 l32 o5 [c>e<]2 w12 v10 c8";

// --- State -------------------------------------------------------------------

type Phase = "title" | "playing" | "dying" | "over";

interface Drifter {
    x: number;
    y: number;
    dx: number;
    dy: number;
    alive: boolean;
}

const state = {
    phase: "title" as Phase,
    x: 120,
    y: 150,
    lives: 3,
    score: 0,
    wave: 1,
    cooldown: 0,
    timer: 0,
    drifters: [] as Drifter[]
};

/** Seeded, so a run can be reproduced by a screenshot tool or a bug report. */
function makeRandom(seed: number): () => number {
    let value = seed >>> 0;
    return () => {
        value = (value * 1664525 + 1013904223) >>> 0;
        return value / 0x100000000;
    };
}
let random = makeRandom(0x5a17);

function spawnWave(wave: number): Drifter[] {
    const count = Math.min(MAX_DRIFTERS, 2 + wave);
    const speed = 0.6 + wave * 0.15;
    return Array.from({ length: count }, () => {
        const angle = random() * Math.PI * 2;
        return {
            x: 16 + random() * (WIDTH - 48),
            y: BAR + 16 + random() * (HEIGHT - BAR - 48),
            dx: Math.cos(angle) * speed,
            dy: Math.sin(angle) * speed,
            alive: true
        };
    });
}

// --- Drawing -----------------------------------------------------------------

/** Lays down the field. Immediate, because nobody wants to watch a title arrive. */
function paintField(gfx: Context["gfx"]): void {
    gfx.now.clear(1);
    for (let i = 0; i < 90; ++i) {
        gfx.now.pixel((random() * WIDTH) | 0, BAR + ((random() * (HEIGHT - BAR)) | 0), 2 + ((random() * 3) | 0));
    }
}

function statusBar(gfx: Context["gfx"]): void {
    gfx.now.fillRect(0, 0, WIDTH, BAR, 1);
    gfx.now.text(2, 1, `${String(state.score).padStart(6, "0")}`, 15);
    gfx.now.text(56, 1, `W${state.wave}`, 11);

    for (let i = 0; i < state.lives; ++i) gfx.now.fillRect(80 + i * 8, 3, 5, 5, 9);

    // What the blitter still owes, which is also how long until you can spray.
    const owed = Math.min(1, gfx.work / 30000);
    gfx.now.text(150, 1, "INK", owed > 0.7 ? 8 : 6);
    gfx.now.rect(172, 2, 82, 6, 6);
    const filled = Math.round((1 - owed) * 80);
    if (filled > 0) gfx.now.fillRect(173, 3, filled, 4, owed > 0.7 ? 8 : 10);
}

function centred(gfx: Context["gfx"], y: number, text: string, color: number): void {
    gfx.now.text((WIDTH - gfx.textWidth(text)) >> 1, y, text, color);
}

// --- Phases ------------------------------------------------------------------

function startGame(ctx: Context): void {
    random = makeRandom(0x5a17 ^ (ctx.frame * 2654435761));
    state.phase = "playing";
    state.lives = 3;
    state.score = 0;
    state.wave = 1;
    state.x = 120;
    state.y = 150;
    state.cooldown = 0;
    state.drifters = spawnWave(1);

    ctx.gfx.abandon();
    paintField(ctx.gfx);
    ctx.bgm.play(THEME, { loop: true });
}

function loseLife(ctx: Context): void {
    --state.lives;
    state.phase = state.lives > 0 ? "dying" : "over";
    state.timer = 60;
    ctx.bgm.play(state.lives > 0 ? FANFARE : KNELL);
    ctx.gfx.abandon();
    // A splash where the ship was, so the loss leaves a mark on the field.
    ctx.gfx.fillCircle(state.x + 8, state.y + 8, 30, 8);
}

function updatePlaying(ctx: Context): void {
    const { input, gfx, bgm } = ctx;

    const { x: dx, y: dy } = input.axis();
    state.x = Math.max(0, Math.min(WIDTH - 16, state.x + dx * 3));
    state.y = Math.max(BAR, Math.min(HEIGHT - 16, state.y + dy * 3));

    if (state.cooldown > 0) --state.cooldown;

    // The queue never drops work, so the game has to hold off itself. That
    // waiting is the reload.
    if (input.btn(BUTTON.A) && state.cooldown === 0 && gfx.work < 24000) {
        gfx.fillCircle(state.x + 8, state.y + 8, 26, INK + ((random() * 3) | 0));
        bgm.effect(psgVoice(2), SPRAY);
        state.cooldown = 10;
    }

    for (const drifter of state.drifters) {
        if (!drifter.alive) continue;

        drifter.x += drifter.dx;
        drifter.y += drifter.dy;
        if (drifter.x < 0 || drifter.x > WIDTH - 16) { drifter.dx = -drifter.dx; drifter.x += drifter.dx * 2; }
        if (drifter.y < BAR || drifter.y > HEIGHT - 16) { drifter.dy = -drifter.dy; drifter.y += drifter.dy * 2; }

        // Painted ground kills. Checked before the drifter scrubs it, so paint
        // laid in front of one catches it as it arrives.
        if (gfx.getPixel(Math.round(drifter.x) + 8, Math.round(drifter.y) + 8) >= INK) {
            drifter.alive = false;
            state.score += 100 * state.wave;
            bgm.effect(psgVoice(2), POP);
            continue;
        }

        // Otherwise it scrubs the ground it stands on.
        gfx.now.fillRect(Math.round(drifter.x) + 4, Math.round(drifter.y) + 4, 8, 8, 1);

        const near = Math.abs(drifter.x - state.x) < 12 && Math.abs(drifter.y - state.y) < 12;
        if (near) {
            loseLife(ctx);
            return;
        }
    }

    if (state.drifters.every((drifter) => !drifter.alive)) {
        ++state.wave;
        state.drifters = spawnWave(state.wave);
        state.score += 500;
    }
}

// --- The app -----------------------------------------------------------------

export const game: App = {
    init({ screen, gfx, sprites, bgm }: Context) {
        // Module-level state, so reset it: the same app can be run twice in a
        // process, by a test or a screenshot tool.
        random = makeRandom(0x5a17);
        state.phase = "title";
        state.drifters = [];
        state.score = 0;
        state.wave = 1;
        state.lives = 3;
        bgm.stop();

        screen.setBackdrop(1);
        // Night below, ink above: 1-7 go dark blue to pale, 8-11 warm.
        for (let i = 1; i < 8; ++i) screen.setColor(i, (i - 1) >> 1, (i - 1) >> 2, i);
        screen.setColor(8, 7, 1, 2);
        screen.setColor(9, 7, 4, 1);
        screen.setColor(10, 7, 6, 2);
        screen.setColor(11, 4, 6, 7);

        paintField(gfx);

        sprites.setSize(16);
        sprites.setPatternFromBitmap(PLAYER_PATTERN, PLAYER_ART);
        sprites.setPatternFromBitmap(DRIFTER_PATTERN, DRIFTER_ART);
        sprites.set(PLAYER_SPRITE, {
            x: state.x, y: state.y, pattern: PLAYER_PATTERN,
            color: [15, 15, 14, 14, 9, 9, 9, 8, 8, 8, 8, 6, 6, 4, 4, 4]
        });
        sprites.setActiveCount(1);
    },

    update(ctx: Context) {
        const { input, sprites } = ctx;

        switch (state.phase) {
            case "title":
                if (input.btnp(BUTTON.B) || input.btnp(BUTTON.A)) startGame(ctx);
                break;

            case "playing":
                updatePlaying(ctx);
                break;

            case "dying":
                if (--state.timer <= 0) {
                    state.phase = "playing";
                    state.x = 120;
                    state.y = 150;
                    state.drifters = spawnWave(state.wave);
                    ctx.bgm.play(THEME, { loop: true });
                }
                break;

            case "over":
                if (--state.timer <= 0 && (input.btnp(BUTTON.B) || input.btnp(BUTTON.A))) {
                    startGame(ctx);
                }
                break;
        }

        // Sprites are free, so every actor is one and they are placed every
        // frame whatever the phase.
        sprites.move(PLAYER_SPRITE, state.x, state.phase === "dying" ? 240 : state.y);
        let slot = 1;
        for (const drifter of state.drifters) {
            if (!drifter.alive || slot > MAX_DRIFTERS) continue;
            sprites.set(slot, {
                x: Math.round(drifter.x), y: Math.round(drifter.y), pattern: DRIFTER_PATTERN,
                color: [11, 11, 11, 7, 7, 7, 5, 5, 5, 5, 7, 7, 7, 11, 11, 11]
            });
            ++slot;
        }
        sprites.setActiveCount(slot);
    },

    draw(ctx: Context) {
        const { gfx } = ctx;
        statusBar(gfx);

        if (state.phase === "title") {
            gfx.now.fillRect(40, 70, 176, 62, 1);
            gfx.now.rect(40, 70, 176, 62, 6);
            centred(gfx, 80, "I N K", 10);
            centred(gfx, 98, "PAINT WHERE THEY ARE GOING", 11);
            centred(gfx, 112, "PRESS X TO START", ctx.frame % 40 < 26 ? 15 : 6);
        }

        if (state.phase === "over") {
            gfx.now.fillRect(56, 84, 144, 44, 1);
            gfx.now.rect(56, 84, 144, 44, 8);
            centred(gfx, 92, "GAME OVER", 8);
            centred(gfx, 108, `SCORE ${state.score}`, 15);
        }
    }
};
