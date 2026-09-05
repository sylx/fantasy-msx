import { describe, expect, it } from "vitest";
import { BUTTON, MOUSE, boot } from "../src/index.js";
import { Garden, pick, position } from "../examples/seed/garden.js";
import { createSeedDemo } from "../examples/seed/demo.js";

function emptyGarden(seed = 1988): Garden {
    const garden = new Garden(seed);
    for (const plot of garden.plots) { plot.age = 0; plot.lifetime = 0; }
    return garden;
}
const shore = (garden: Garden, x: number, y: number) => garden.plots.some(other => other.pond
    && Math.abs(x - other.x) + Math.abs(y - other.y) === 1);

describe("SEED's garden", () => {
    it("makes reproducible, varied islands with connected ground, water and planting space", () => {
        const shapes = new Set<string>();
        for (let seed = 1988; seed < 2088; ++seed) {
            const garden = new Garden(seed);
            expect(garden.plots).toEqual(new Garden(seed).plots);
            expect(garden.plots.some(plot => plot.pond)).toBe(true);
            expect(garden.plots.filter(plot => !plot.pond && !plot.age).length).toBeGreaterThan(15);
            const reached = new Set([garden.plots[0]]);
            for (const plot of reached) for (const next of garden.plots) {
                if (Math.abs(plot.x - next.x) + Math.abs(plot.y - next.y) === 1) reached.add(next);
            }
            expect(reached.size).toBe(garden.plots.length);
            shapes.add(garden.plots.map(plot => `${plot.x},${plot.y},${plot.pond}`).join(";"));
        }
        expect(shapes.size).toBeGreaterThan(90);
    });

    it("waits for water, then grows a seed into a mature tree", () => {
        const garden = emptyGarden();
        const plot = garden.plots.find(plot => !plot.pond && !shore(garden, plot.x, plot.y))!;
        expect(garden.plant(plot)).toBe(true);
        for (let i = 0; i < 10; ++i) garden.tick();
        expect(plot.age).toBe(1);
        garden.shower();
        for (let i = 0; i < 3; ++i) garden.tick();
        expect(plot.age).toBe(4);
        expect(garden.plant(plot)).toBe(false);
    });

    it("keeps the pond clear and waters the ground next to it", () => {
        const garden = emptyGarden();
        expect(garden.plant(garden.plots.find(plot => plot.pond)!)).toBe(false);
        const plot = garden.plots.find(plot => !plot.pond && shore(garden, plot.x, plot.y))!;
        garden.plant(plot);
        for (let i = 0; i < 4; ++i) garden.tick();
        expect(plot.age).toBe(4);
    });

    function crowded() {
        const garden = emptyGarden();
        const centre = garden.plots.find(plot => !plot.pond && garden.plots.filter(other => !other.pond
            && Math.max(Math.abs(other.x - plot.x), Math.abs(other.y - plot.y)) <= 1).length >= 7)!;
        const neighbours = garden.plots.filter(plot => !plot.pond
            && Math.max(Math.abs(plot.x - centre.x), Math.abs(plot.y - centre.y)) <= 1);
        for (const plot of neighbours) plot.age = 4;
        return { garden, centre, neighbours };
    }

    it("crowded crowns fade even in rain, decay to soil, and can grow again", () => {
        const { garden, centre } = crowded();
        for (let i = 0; i < 2; ++i) { garden.shower(); garden.tick(); }
        expect(centre.age).toBe(4);
        expect(centre.stress).toBeGreaterThanOrEqual(4);
        for (let i = 0; i < 3; ++i) { garden.shower(); garden.tick(); }
        expect(centre.dead).toBeGreaterThan(0);
        expect(centre.age).toBe(0);
        expect(garden.plant(centre)).toBe(false);
        // Remove competing seed sources so natural re-seeding cannot mask decay.
        for (const plot of garden.plots) if (plot !== centre) plot.age = 0;
        while (centre.dead) garden.tick();
        expect(centre.compost).toBeGreaterThan(0);
        expect(centre.water).toBeGreaterThan(0);
        expect(garden.plant(centre)).toBe(true);
        for (let i = 0; i < 3; ++i) garden.tick();
        expect(centre.age).toBe(4);
    });

    it("thinning allows a fading neighbour to recover", () => {
        const { garden, centre, neighbours } = crowded();
        for (let i = 0; i < 2; ++i) { garden.shower(); garden.tick(); }
        for (const plot of neighbours) if (plot !== centre) garden.clear(plot);
        garden.tick(); garden.tick();
        expect(centre.age).toBe(4);
        expect(centre.stress).toBe(0);
    });

    it("rain rescues drought stress, but even an isolated watered tree eventually dies", () => {
        const garden = emptyGarden();
        const plot = garden.plots.find(plot => !plot.pond && !shore(garden, plot.x, plot.y))!;
        plot.age = 4;
        for (let i = 0; i < 18; ++i) garden.tick();
        expect(plot.stress).toBeGreaterThanOrEqual(4);
        garden.shower(); garden.tick(); garden.tick();
        expect(plot.stress).toBe(0);
        plot.lifetime = 100;
        garden.tick();
        expect(plot.dead).toBeGreaterThan(0);
    });

    it("birds arrive, perch, deliver a seed across a gap and leave", () => {
        const garden = new Garden();
        while (!garden.bird && garden.seconds < 30) garden.tick();
        expect(garden.bird).not.toBeNull();
        const bird = garden.bird!;
        const drop = bird.drop!;
        expect(Math.abs(drop.x - bird.tree.x) + Math.abs(drop.y - bird.tree.y)).toBeGreaterThanOrEqual(3);
        garden.tick(); garden.tick();
        expect(bird.phase).toBe(2);
        for (let i = 0; i < 4; ++i) garden.tick();
        expect(drop.age).toBe(1);
        expect(garden.seedsDelivered).toBe(1);
        garden.tick(); garden.tick();
        expect(garden.bird).toBeNull();
    });

    it("does not overwrite a tree planted at a bird's destination while it is flying", () => {
        const garden = new Garden();
        while (!garden.bird && garden.seconds < 30) garden.tick();
        const drop = garden.bird!.drop!;
        garden.plant(drop);
        drop.age = 4;
        for (let i = 0; i < 6; ++i) garden.tick();
        expect(garden.seedsDelivered).toBe(0);
        expect(drop.age).toBe(4);
    });

    it("keeps cycling instead of saturating after five minutes of rain", () => {
        const a = new Garden(), b = new Garden();
        let deaths = 0, births = 0;
        for (let i = 0; i < 300; ++i) {
            const before = a.plots.map(plot => ({ age: plot.age, dead: plot.dead }));
            if (i % 8 === 0) { a.shower(); b.shower(); }
            a.tick(); b.tick();
            a.plots.forEach((plot, n) => {
                if (!before[n].dead && plot.dead) ++deaths;
                if (!before[n].age && plot.age) ++births;
            });
        }
        expect(a.plots).toEqual(b.plots);
        expect(deaths).toBeGreaterThan(10);
        expect(births).toBeGreaterThan(deaths);
        expect(a.planted).toBeLessThan(a.plots.filter(plot => !plot.pond).length);
        expect(a.mature.length).toBeGreaterThan(0);
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
        const plot = new Garden().plots.find(plot => position(plot).x > x + 20)!;
        const p = position(plot);
        runtime.pointer.setPosition(p.x, p.y);
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

    it("regenerates terrain with R and the clickable label, discarding unfinished scenery", () => {
        const runtime = boot({ blitterSpeed: 0.05 });
        runtime.run(createSeedDemo());
        const landscape = () => runtime.bios.system.vdp.vram.slice(runtime.screen.displayPage * 32768 + 28 * 128,
            runtime.screen.displayPage * 32768 + 178 * 128);
        const first = landscape();
        runtime.input.setButton(BUTTON.B, true);
        runtime.step(61);
        expect(runtime.gfx.busy).toBe(true);
        runtime.input.releaseAll();
        runtime.input.setKey("KeyR", true);
        runtime.step();
        const second = landscape();
        expect(second).not.toEqual(first);
        expect(runtime.gfx.busy).toBe(false);
        expect(runtime.bios.system.psg.read(10)).toBe(0);
        runtime.input.releaseAll();
        runtime.step(30);
        expect(runtime.gfx.busy).toBe(false);
        runtime.pointer.setPosition(200, 200);
        runtime.pointer.setButton(MOUSE.LEFT, true);
        runtime.step();
        expect(landscape()).not.toEqual(second);
        expect(runtime.gfx.busy).toBe(false);
        runtime.stop();
    });

    it("draws a visiting bird and hides it again on regeneration", () => {
        const runtime = boot();
        runtime.run(createSeedDemo());
        const model = new Garden();
        while (!model.bird && model.seconds < 30) model.tick();
        // Taking control stops attract-mode rain from changing the visit.
        runtime.input.setButton(BUTTON.LEFT, true);
        runtime.step();
        runtime.input.releaseAll();
        runtime.step(model.seconds * 60);
        const attribute = runtime.screen.spriteTables.attributes + 4;
        expect(runtime.bios.system.vdp.vram[attribute]).toBeLessThan(178);
        runtime.input.setKey("KeyR", true);
        runtime.step();
        expect(runtime.bios.system.vdp.vram[attribute]).toBe(213);
        runtime.stop();
    });
});
