import { describe, expect, it } from "vitest";
import { BUTTON, boot } from "../src/index.js";
import { Garden, pick, position } from "../examples/seed/garden.js";
import { createSeedDemo } from "../examples/seed/demo.js";

describe("SEED's garden", () => {
    it("waits for water, then grows a seed into a mature tree", () => {
        const garden = new Garden();
        const plot = garden.at(5, 7)!;
        expect(garden.plant(plot)).toBe(true);
        for (let i = 0; i < 10; ++i) garden.tick();
        expect(plot.age).toBe(1);
        garden.shower();
        for (let i = 0; i < 3; ++i) garden.tick();
        expect(plot.age).toBe(4);
        expect(garden.plant(plot)).toBe(false);
    });

    it("keeps the pond clear and waters the ground next to it", () => {
        const garden = new Garden();
        expect(garden.plant(garden.at(6, 3)!)).toBe(false);
        const shore = garden.at(6, 5)!;
        garden.plant(shore);
        for (let i = 0; i < 4; ++i) garden.tick();
        expect(shore.age).toBe(4);
    });

    it("spreads reproducibly into wet neighbours and keeps the population bounded", () => {
        const a = new Garden(), b = new Garden(), dry = new Garden();
        const original = dry.planted;
        const empty = dry.plots.filter(plot => !plot.age && !plot.pond);
        for (let i = 0; i < 80; ++i) {
            a.shower(); b.shower();
            a.tick(); b.tick(); dry.tick();
        }
        expect(a.plots).toEqual(b.plots);
        expect(a.planted).toBeGreaterThan(original);
        expect(dry.planted).toBeLessThan(a.planted);
        // Without rain, only the pond's immediate shore can receive seeds.
        for (const plot of empty.filter(plot => plot.age)) {
            expect(dry.plots.some(other => other.pond
                && Math.abs(plot.x - other.x) + Math.abs(plot.y - other.y) === 1)).toBe(true);
        }
        expect(a.planted).toBeLessThanOrEqual(a.plots.filter(plot => !plot.pond).length);
        expect(a.plots.every(plot => plot.age >= 0 && plot.age <= 4)).toBe(true);
    });

    it("picks each ground tile and rejects the sea and interface", () => {
        const garden = new Garden();
        for (const plot of garden.plots) {
            const p = position(plot);
            expect(pick(garden, p.x, p.y)).toBe(plot);
        }
        expect(pick(garden, 10, 100)).toBeUndefined();
        expect(pick(garden, 128, 199)).toBeUndefined();
    });
});

describe("SEED on the machine", () => {
    it("keeps cursor and rain responsive while a slow blitter owns the hidden page", () => {
        const runtime = boot({ blitterSpeed: 0.05 });
        runtime.run(createSeedDemo());
        runtime.step(61);
        expect(runtime.gfx.busy).toBe(true);
        const displayed = runtime.screen.displayPage;
        const attribute = runtime.screen.spriteTables.attributes;
        const vram = runtime.bios.system.vdp.vram;
        const x = vram[attribute + 1];
        runtime.input.setButton(BUTTON.RIGHT, true);
        runtime.input.setButton(BUTTON.B, true);
        runtime.step();
        expect(vram[attribute + 1]).toBeGreaterThan(x);
        expect(runtime.bios.system.psg.read(10)).toBe(5);
        expect(runtime.gfx.busy).toBe(true);
        expect(runtime.screen.displayPage).toBe(displayed);
        const backlog = runtime.gfx.work;
        runtime.input.releaseAll();
        runtime.step(120);
        expect(runtime.gfx.work).toBeLessThan(backlog);
        runtime.stop();
    });

    it("discards unfinished scenery when starting a new island", () => {
        const runtime = boot({ blitterSpeed: 0.05 });
        runtime.run(createSeedDemo());
        runtime.input.setButton(BUTTON.B, true);
        runtime.step(61);
        expect(runtime.gfx.busy).toBe(true);
        runtime.input.releaseAll();
        runtime.input.setKey("KeyR", true);
        runtime.step();
        expect(runtime.gfx.busy).toBe(false);
        expect(runtime.bios.system.psg.read(10)).toBe(0);
        runtime.step(30);
        expect(runtime.gfx.busy).toBe(false);
        runtime.stop();
    });
});
