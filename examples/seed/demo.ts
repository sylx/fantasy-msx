// SEED — a place to tend. Simulation, sprites and the blitter each have their
// own clock. The landscape is only repainted when the world changes, on a
// hidden page; the insects keep flying while the real-speed blitter works.
import { BUTTON, INSTRUMENT, MOUSE, type App, type Context, type OpllChannel } from "../../src/index.js";
import { Garden, pick, position, type Plot } from "./garden.js";

type Painter = Pick<Context["gfx"], "fillRect" | "hline" | "line" | "text">;
type Color = readonly [number, number, number];
const DAY: readonly Color[] = [
    [0, 0, 0], [1, 2, 3], [1, 3, 4], [2, 4, 5],
    [2, 2, 3], [3, 3, 3], [5, 4, 3], [3, 4, 3],
    [1, 3, 3], [2, 5, 4], [4, 6, 4], [6, 7, 5],
    [7, 4, 4], [7, 6, 4], [3, 6, 6], [7, 7, 6]
];
const NIGHT: readonly Color[] = [
    [0, 0, 0], [0, 0, 1], [1, 1, 2], [1, 2, 3],
    [1, 1, 2], [2, 2, 3], [3, 3, 4], [2, 3, 3],
    [0, 2, 2], [1, 3, 3], [2, 4, 4], [4, 5, 5],
    [5, 3, 5], [7, 5, 3], [2, 5, 6], [7, 7, 6]
];
const NOTES = [60, 62, 64, 67, 69, 72, 74, 76];
const hz = (note: number) => 440 * 2 ** ((note - 69) / 12);

function diamond(p: Painter, x: number, y: number, color: number): void {
    for (let row = -4; row <= 4; ++row) {
        const half = 10 - Math.abs(row) * 2;
        p.hline(x - half, y + row, half * 2, color);
    }
}

function tree(p: Painter, plot: Plot): void {
    const { x, y } = position(plot);
    if (!plot.age) {
        p.hline(x - 3, y, 2, plot.water ? 9 : 6);
        if (plot.variant === 1) p.hline(x + 2, y - 2, 2, 7);
        return;
    }
    p.hline(x - 5, y + 1, 10, 8);         // ground shadow
    if (plot.age === 1) {
        p.fillRect(x - 1, y - 2, 2, 2, 13);
        return;
    }
    if (plot.age < 4) {
        p.fillRect(x, y - 6, 2, 7, 9);
        p.hline(x - 4, y - 6, 5, 10);
        p.hline(x + 2, y - 8, 4, 11);
        if (plot.age === 3) p.fillRect(x - 3, y - 11, 5, 4, 10);
        return;
    }
    const height = 17 + plot.variant * 4;
    p.fillRect(x - 1, y - height, 3, height + 1, 5);
    p.line(x, y - 5, x + 5, y - 11, 6);
    if (plot.variant === 0) {
        // Cedar: three irregular, stepped tiers, each with a sunward edge.
        for (let tier = 0; tier < 3; ++tier) {
            const top = y - 25 + tier * 6;
            for (let row = 0; row < 9; ++row) {
                const half = 1 + Math.floor(row * 0.8) + tier;
                p.hline(x - half, top + row, half * 2 + 1, 9);
                p.hline(x - half, top + row, half, row % 3 === 0 ? 11 : 10);
            }
        }
    } else {
        // Broad crowns: small blocks deliberately retain the pixel silhouette.
        const leaf = plot.variant === 1 ? 10 : 12;
        p.fillRect(x - 8, y - height - 4, 16, 13, 8);
        p.fillRect(x - 11, y - height - 1, 21, 7, 9);
        p.fillRect(x - 7, y - height - 7, 12, 15, leaf);
        p.fillRect(x - 10, y - height - 3, 17, 8, leaf);
        p.fillRect(x - 5, y - height - 8, 7, 3, plot.variant === 1 ? 11 : 13);
        p.hline(x - 8, y - height - 3, 4, 11);
        p.hline(x + 3, y - height + 5, 5, 9);
        if (plot.variant === 2) {
            p.fillRect(x + 3, y - height - 2, 2, 2, 15);
            p.fillRect(x - 6, y - height + 3, 2, 2, 13);
        }
    }
}

function landscape(p: Painter, garden: Garden): void {
    p.fillRect(0, 28, 256, 150, 1);
    // A sea suspended in the sky. These marks never need animation: changing
    // palette registers lights the same pixels at a different time of day.
    for (let i = 0; i < 36; ++i) {
        const x = (i * 73 + 17) % 250;
        const y = 34 + (i * 37) % 133;
        p.hline(x, y, i % 3 ? 3 : 9, i % 3 ? 2 : 3);
    }
    // Floating rock, back to front. Tile faces form an irregular island edge.
    const order = [...garden.plots].sort((a, b) => a.x + a.y - b.x - b.y || a.x - b.x);
    for (const plot of order) {
        const { x, y } = position(plot);
        const depth = 14 + (plot.x * 7 + plot.y * 3) % 9;
        for (let col = -10; col < 10; ++col) {
            const edge = 5 - Math.floor(Math.abs(col) / 2);
            p.fillRect(x + col, y + edge, 1, depth, col < 0 ? 5 : 4);
        }
        p.line(x - 8, y + 8, x - 8, y + depth, 6);
        diamond(p, x, y, plot.pond ? 3 : plot.water ? 7 : 6);
        if (plot.pond) {
            p.hline(x - 6, y - 1, 10, 14);
            p.hline(x, y + 2, 6, 2);
        }
    }
    // Water escaping through the rock, with glints painted by the blitter.
    p.fillRect(177, 132, 4, 28, 3);
    p.fillRect(178, 134, 2, 21, 14);
    p.hline(173, 162, 12, 2);
    for (const plot of order) if (!plot.pond) tree(p, plot);
}

function patterns({ sprites }: Context): void {
    sprites.setSize(16);
    sprites.setEnabled(true);
    const cursor = Array.from({ length: 16 }, (_, y) => {
        const half = Math.max(0, 7 - Math.abs(y - 9) * 2);
        return y < 6 || y > 12 ? 0 : (1 << (8 - half)) | (1 << (8 + half));
    });
    sprites.setPattern(0, cursor);
    sprites.setPattern(4, [0x0000, 0x4800, 0x3000, 0x3000, 0x4800, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0]);
    sprites.setPattern(8, [0x0800, 0x0800, 0x1000, 0x1000, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0]);
    sprites.setPattern(12, [0x1000, 0x3800, 0x1000, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0]);
    sprites.hideAll();
    sprites.setActiveCount(24);
}

export function createSeedDemo(): App {
    let garden: Garden;
    let selected: Plot;
    let frame = 0;
    let dirty = false;
    let painting = false;
    let touched = false;
    let repeat = 0;
    let message = "A LITTLE CARE CHANGES EVERYTHING";
    let messageUntil = 0;
    let lastHud = "";

    function reset(ctx: Context): void {
        garden = new Garden();
        selected = garden.at(5, 6)!;
        frame = 0;
        dirty = painting = touched = false;
        repeat = 0;
        message = "A LITTLE CARE CHANGES EVERYTHING";
        messageUntil = 360;
        lastHud = "";
        ctx.gfx.abandon();
        ctx.screen.setPalette(DAY);
        ctx.screen.useDoubleBuffer();
        for (const page of [0, 1]) {
            ctx.screen.setDrawPage(page);
            ctx.gfx.now.clear(1);
        }
        landscape(ctx.gfx.now, garden);        // only the boot picture is instant
        ctx.screen.flip();
        ctx.bios.system.opll.silence();
        ctx.bios.system.psg.silence();
    }

    function say(text: string): void { message = text; messageUntil = frame + 240; }

    function sow(ctx: Context): void {
        if (garden.plant(selected)) {
            dirty = true;
            say("SEED PLANTED. X CALLS THE RAIN.");
            ctx.bios.system.opll.play(5, hz(NOTES[(selected.x + selected.y) % 8]), INSTRUMENT.VIBRAPHONE, 2);
        } else say(selected.pond ? "THE POND WATERS ITS NEIGHBOURS." : "ALREADY GROWING. TRY AN EMPTY PATCH.");
    }

    function rain(): void {
        garden.shower();
        dirty = true;
        say("RAIN FEEDS ROOTS. ROOTS MAKE A FOREST.");
    }

    function sound(ctx: Context): void {
        const { opll, psg } = ctx.bios.system;
        const trees = garden.mature;
        // A phrase reads the actual trees in ground-grid order.
        // More roots add bass, harmony and a second answering melody.
        if (frame % 24 === 0) {
            const step = Math.floor(frame / 24);
            const root = [48, 45, 53, 48][Math.floor(step / 16) % 4];
            for (const channel of [0, 4, 5] as OpllChannel[]) opll.setKeyOn(channel, false);
            const plant = trees[step % Math.max(1, trees.length)];
            if (plant) opll.play(0, hz(root + NOTES[(plant.x + plant.y + step) % 8] - 48), INSTRUMENT.VIBRAPHONE, 2);
            if (step % 8 === 0) {
                opll.play(1, hz(root - 12), INSTRUMENT.ACOUSTIC_BASS, 5);
                if (trees.length >= 8) opll.play(2, hz(root + 7), INSTRUMENT.ORGAN, 7);
                if (trees.length >= 16) opll.play(3, hz(root + 14), INSTRUMENT.FLUTE, 6);
            }
            if (trees.length >= 12 && step % 2) opll.play(4, hz(root + 24 + [0, 4, 7, 9][step % 4]), INSTRUMENT.GUITAR, 6);
        }
        psg.setMixer([true, false, false], [false, false, garden.rain > 0]);
        psg.setNoisePeriod(18);
        psg.setVolume(2, garden.rain ? 5 : 0);
        const chirp = frame % 180;
        psg.setTone(0, 1100 + chirp * 45);
        psg.setVolume(0, trees.length >= 8 && chirp < 9 ? 6 : 0);
    }

    function actors({ sprites }: Context): void {
        const p = position(selected);
        sprites.set(0, { x: p.x - 8, y: p.y - 9, pattern: 0, color: frame % 48 < 32 ? 15 : 13 });
        const trees = garden.mature;
        const count = Math.min(7, Math.floor(trees.length / 2));
        for (let i = 0; i < 7; ++i) {
            if (i >= count) { sprites.hide(i + 1); continue; }
            const home = position(trees[(i * 3) % trees.length]);
            const t = frame / 60 + i * 2.4;
            sprites.set(i + 1, { x: Math.round(home.x + Math.sin(t * 0.8) * 17),
                y: Math.round(home.y - 23 + Math.cos(t * 1.3) * 7),
                pattern: frame % 2880 > 1440 ? 12 : 4, color: i % 2 ? 13 : 15 });
        }
        // Sixteen rain sprites, staggered vertically to respect the eight per
        // scanline limit. Cursor and insects have priority when they cross.
        for (let i = 0; i < 16; ++i) {
            if (!garden.rain) { sprites.hide(i + 8); continue; }
            sprites.set(i + 8, { x: 30 + ((i * 47 - frame + 100000) % 192),
                y: 32 + ((i * 9 + frame * 3) % 136), pattern: 8, color: 14 });
        }
    }

    function hud(ctx: Context): void {
        const night = (1 - Math.cos(frame / 2880 * Math.PI * 2)) / 2;
        const label = garden.rain ? "RAIN" : night > 0.7 ? "NIGHT" : night > 0.3 ? "DUSK" : "DAY";
        const hint = frame < messageUntil ? message : !touched
            ? "WATCHING IT GROW. JOIN IN ANY TIME." : garden.mature.length >= 24
                ? "A FOREST, AND A SONG, OF YOUR OWN." : "PLANT A SEED. RAIN. LISTEN IT GROW.";
        const status = `${label}  ROOTS ${String(garden.mature.length).padStart(2, "0")}  LIFE ${String(Math.min(7, Math.floor(garden.mature.length / 2))).padStart(2, "0")}`;
        const key = hint + status;
        if (key === lastHud) return;
        lastHud = key;
        const back = ctx.screen.drawPage;
        // Both pages get the same small interface, outside the landscape's
        // clip. A slow render must never swallow a click's acknowledgement.
        for (const page of [0, 1]) {
            ctx.screen.setDrawPage(page);
            const p = ctx.gfx.now;
            p.fillRect(0, 0, 256, 28, 1);
            p.text(10, 7, "S E E D", 11);
            p.text(88, 8, status, 15);
            p.hline(10, 23, 236, 3);
            p.fillRect(0, 178, 256, 34, 1);
            p.hline(10, 179, 236, 3);
            p.text(10, 185, hint, 11);
            p.text(10, 199, "Z PLANT", 15);
            p.text(86, 199, "X RAIN", garden.rain ? 14 : 15);
            p.text(162, 199, "R NEW ISLAND", 6);
        }
        ctx.screen.setDrawPage(back);
    }

    return {
        init(ctx) {
            ctx.screen.setMode("G4");
            ctx.screen.setBackdrop(1);
            patterns(ctx);
            reset(ctx);
            hud(ctx);
        },
        update(ctx) {
            ++frame;
            const { input, pointer, screen } = ctx;
            if (input.keyp("KeyR")) { reset(ctx); touched = true; actors(ctx); return; }
            const axis = input.axis();
            const moving = axis.x !== 0 || axis.y !== 0;
            if (moving && (repeat === 0 || repeat >= 16 && repeat % 6 === 0)) {
                // Move along the island's two grid axes. Both the keyboard
                // and the launcher's touch pad work.
                const next = garden.at(selected.x + axis.x, selected.y + axis.y);
                if (next) selected = next;
                touched = true;
            }
            repeat = moving ? repeat + 1 : 0;
            if (pointer.inside && (pointer.dx || pointer.dy || pointer.pressed())) {
                const plot = pick(garden, pointer.x, pointer.y);
                if (plot) selected = plot;
            }
            if (pointer.inside && pointer.pressed()) {
                touched = true;
                if (pointer.y >= 195 && pointer.x >= 158) { reset(ctx); touched = true; actors(ctx); return; }
                else if (pointer.y >= 195 && pointer.x >= 80) rain();
                else if (pointer.y >= 195 || pick(garden, pointer.x, pointer.y)) sow(ctx);
            }
            if (input.btnp(BUTTON.A)) { touched = true; sow(ctx); }
            if (input.btnp(BUTTON.B) || pointer.inside && pointer.pressed(MOUSE.RIGHT)) { touched = true; rain(); }
            // Attract mode starts after eight seconds, and ends on the first
            // action. Merely moving the mouse does not accidentally end it.
            if (!touched && frame >= 480 && frame % 120 === 0) {
                const empty = garden.plots.filter(plot => !plot.pond && !plot.age);
                if (empty.length) {
                    selected = empty[(Math.floor(frame / 120) * 17) % empty.length];
                    garden.plant(selected);
                    dirty = true;
                }
                if (frame % 480 === 0) { garden.shower(); dirty = true; }
            }
            if (frame % 60 === 0) dirty = garden.tick() || dirty;
            if (frame % 12 === 0) {
                const night = (1 - Math.cos(frame / 2880 * Math.PI * 2)) / 2;
                screen.setPalette(DAY.map((color, i): Color => {
                    const mix = (c: number) => Math.round(color[c] + (NIGHT[i][c] - color[c]) * night);
                    return [mix(0), mix(1), mix(2)];
                }));
            }
            sound(ctx);
            actors(ctx);
        },
        draw(ctx) {
            if (painting && !ctx.gfx.busy) { ctx.screen.flip(); painting = false; }
            if (dirty && !painting) {
                ctx.gfx.setClip(0, 28, 256, 150);
                landscape(ctx.gfx, garden);
                ctx.gfx.resetClip();
                painting = true;
                dirty = false;
            }
            hud(ctx);
        }
    };
}

export const demo = createSeedDemo();
