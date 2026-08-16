// A small program that shows the three clocks pulling against each other.
//
//   - the ship is a hardware sprite, so it moves at 60Hz for nothing
//   - the trigger queues a bloom big enough that you watch it grow
//   - the readout is drawn with gfx.now, so it never waits in that queue
//
// Arrows or WASD to move, Z to fire, X to wipe the screen. Nothing here runs
// the blitter faster than a real V9938 would; the shapes are just large enough
// that its pace is visible. Smaller ones finish inside a frame and look
// instant, which is equally true of the hardware.

import { BUTTON, type App, type Context } from "../src/index.js";

const SHIP = 0;
const STARS = 80;

/** Seeded, so a run can be reproduced - by a screenshot tool or by a bug report. */
function makeRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}
const random = makeRandom(0x5a17);

const state = {
    x: 120,
    y: 150,
    cooldown: 0,
    /** Largest amount of queued work seen, so the bar has something to scale to. */
    peak: 1
};

/** Scatters the stars. Queued, so it arrives with everything else. */
function stars(gfx: Context["gfx"]): void {
    for (let i = 0; i < STARS; ++i) {
        gfx.pixel((random() * 256) | 0, (random() * 212) | 0, 4 + ((random() * 3) | 0));
    }
}

export const game: App = {
    init({ screen, gfx, sprites }: Context) {
        // Module-level state, so reset it: the same app can be run more than
        // once in a process, by a test or a screenshot tool.
        state.x = 120;
        state.y = 150;
        state.cooldown = 0;
        state.peak = 1;

        screen.setBackdrop(1);
        // A dusk palette: entries 1-7 go from near-black to a pale sky.
        for (let i = 1; i < 8; ++i) screen.setColor(i, (i - 1) >> 1, (i - 1) >> 2, i);
        screen.setColor(8, 7, 2, 1);
        screen.setColor(9, 7, 5, 2);
        screen.setColor(10, 4, 0, 2);

        // The boot screen has to be there at once, so it skips the queue.
        gfx.now.clear(1);
        stars(gfx);

        sprites.setSize(16);
        sprites.setPatternFromBitmap(SHIP, [
            ".......##.......", "......####......", "......####......", ".....######.....",
            ".....######.....", "....########....", "....##.##.##....", "...####..####...",
            "...###....###...", "..####....####..", "..###......###..", ".####......####.",
            ".##..........##.", "###..........###", "##............##", "................"
        ]);
        sprites.set(SHIP, {
            x: state.x, y: state.y, pattern: SHIP,
            color: [15, 15, 14, 14, 9, 9, 9, 8, 8, 8, 8, 6, 6, 4, 4, 4]
        });
        sprites.setActiveCount(1);
    },

    update({ input, sprites, gfx }: Context) {
        const { x: dx, y: dy } = input.axis();
        state.x = Math.max(0, Math.min(240, state.x + dx * 3));
        state.y = Math.max(0, Math.min(196, state.y + dy * 3));
        sprites.move(SHIP, state.x, state.y);

        if (state.cooldown > 0) --state.cooldown;

        // Refuse to fire while the machine is already behind. This is the back
        // pressure a game has to apply for itself: the queue never drops work.
        if (input.btnp(BUTTON.A) && state.cooldown === 0 && gfx.work < 40000) {
            // Big enough to take the chip several frames, so it can be watched.
            const radius = 48 + ((random() * 32) | 0);
            gfx.fillCircle(state.x + 8, state.y + 8, radius, 8 + ((random() * 2) | 0));
            gfx.circle(state.x + 8, state.y + 8, radius + 3, 15);
            state.cooldown = 8;
        }

        // A wipe, at an odd x so the chip cannot move whole bytes. That is the
        // slowest thing it does: most of a third of a second, in full view.
        if (input.btnp(BUTTON.B) && !gfx.busy) {
            gfx.fillRect(1, 0, 255, 212, 10);
            stars(gfx);
        }
    },

    draw({ gfx }: Context) {
        // Immediate: a readout that would be useless if it lagged behind what
        // it reports on.
        state.peak = Math.max(state.peak, gfx.work);

        gfx.now.fillRect(0, 0, 256, 11, 1);
        gfx.now.text(2, 2, `QUEUE ${String(gfx.pending).padStart(3)}`, gfx.busy ? 9 : 6);
        gfx.now.text(80, 2, `${String(gfx.work).padStart(6)} PX LEFT`, gfx.busy ? 9 : 6);

        // A bar for what is left to draw, which empties as the chip catches up.
        const filled = gfx.work > 0 ? Math.max(1, Math.round((gfx.work / state.peak) * 60)) : 0;
        gfx.now.rect(192, 2, 62, 7, 6);
        if (filled > 0) gfx.now.fillRect(193, 3, filled, 5, 9);
    }
};
