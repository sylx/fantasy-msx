// A small program that shows the three clocks pulling against each other.
//
//   - the ship is a hardware sprite, so it moves at 60Hz for nothing
//   - pressing the trigger queues a bloom the blitter has to grind out
//   - the readout is drawn with gfx.now, so it never waits in that queue
//
// Arrows or WASD to move, Z (or gamepad A) to fire.

import { BUTTON, type App, type Context } from "../src/index.js";

const SHIP = 0;
const STARS = 60;

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
    blooms: [] as Array<{ x: number; y: number; radius: number; color: number }>,
    cooldown: 0
};

export const game: App = {
    init({ screen, gfx, sprites }: Context) {
        // Module-level state, so reset it: the same app can be run more than
        // once in a process, by a test or a screenshot tool.
        state.x = 120;
        state.y = 150;
        state.blooms.length = 0;
        state.cooldown = 0;

        screen.setBackdrop(1);
        // A dusk palette: entries 1-7 go from near-black to a pale sky.
        for (let i = 1; i < 8; ++i) screen.setColor(i, (i - 1) >> 1, (i - 1) >> 2, i);
        screen.setColor(8, 7, 2, 1);
        screen.setColor(9, 7, 5, 2);

        // The boot screen has to be there at once, so it skips the queue.
        gfx.now.clear(1);
        for (let i = 0; i < STARS; ++i) {
            gfx.now.pixel((random() * 256) | 0, (random() * 212) | 0, 4 + ((random() * 3) | 0));
        }

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
        if (input.btnp(BUTTON.A) && state.cooldown === 0 && gfx.pending < 40) {
            state.blooms.push({
                x: state.x + 8, y: state.y + 8,
                radius: 12 + ((random() * 24) | 0),
                color: 8 + ((random() * 2) | 0)
            });
            state.cooldown = 6;
        }
    },

    draw({ gfx }: Context) {
        // Queued: these take the blitter several frames each, and you see it.
        for (const bloom of state.blooms) {
            gfx.fillCircle(bloom.x, bloom.y, bloom.radius, bloom.color);
            gfx.circle(bloom.x, bloom.y, bloom.radius + 3, 15);
        }
        state.blooms.length = 0;

        // Immediate: a readout that would be useless if it lagged.
        gfx.now.fillRect(0, 0, 256, 9, 1);
        gfx.now.text(2, 1, `QUEUE ${String(gfx.pending).padStart(3)}  WORK ${String(gfx.work).padStart(6)}`, gfx.busy ? 9 : 6);
    }
};
