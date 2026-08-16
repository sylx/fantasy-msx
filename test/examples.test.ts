import { describe, expect, it } from "vitest";
import { BUTTON, boot } from "../src/index.js";
import { EXAMPLES, findExample } from "../examples/registry.js";

describe("the example registry", () => {
    it("gives every entry a unique id and something to read", () => {
        const ids = EXAMPLES.map((example) => example.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const example of EXAMPLES) {
            expect(example.title.length).toBeGreaterThan(0);
            expect(example.summary.length).toBeGreaterThan(20);
            expect(example.controls.length).toBeGreaterThan(0);
        }
    });

    it("falls back to the first entry for an unknown id", () => {
        expect(findExample("wire").id).toBe("wire");
        expect(findExample("nonsense")).toBe(EXAMPLES[0]);
        expect(findExample(null)).toBe(EXAMPLES[0]);
    });

    it("loads and runs each one", async () => {
        for (const example of EXAMPLES) {
            const app = await example.load();
            expect(typeof app.update).toBe("function");

            const runtime = boot();
            runtime.run(app);
            runtime.step(30);
            expect(runtime.frame).toBe(30);
            expect(runtime.bios.system.machine.getFrame()).not.toBeNull();
        }
    });
});

describe("the WIRE demo", () => {
    it("runs in SCREEN 7, on two pages, with the FM chip going", async () => {
        const { demo } = await import("../examples/wire/demo.js");
        const runtime = boot();
        runtime.run(demo);
        runtime.step(10);

        expect(runtime.screen.mode.name).toBe("G6");
        expect(runtime.screen.width).toBe(512);
        expect(runtime.screen.mode.pages).toBe(2);
        expect(runtime.bgm.playing).toBe(true);
        // Four FM voices and a PSG bass means both chips are connected.
        expect(runtime.bios.system.machine.getAudioSignals()).toHaveLength(2);
    });

    it("draws to the page it is about to show, and swaps every frame", async () => {
        const { demo } = await import("../examples/wire/demo.js");
        const runtime = boot();
        runtime.run(demo);

        runtime.step(1);
        const first = runtime.screen.displayPage;
        runtime.step(1);
        expect(runtime.screen.displayPage).not.toBe(first);
    });

    it("puts ink on both pages, so neither is ever blank", async () => {
        const { demo } = await import("../examples/wire/demo.js");
        const runtime = boot();
        runtime.run(demo);
        runtime.step(20);

        const vram = runtime.bios.system.vdp.vram;
        const painted = (base: number) => {
            let count = 0;
            for (let i = base; i < base + 212 * 256; ++i) if (vram[i] !== 0x11) ++count;
            return count;
        };
        expect(painted(0x00000)).toBeGreaterThan(1000);
        expect(painted(0x10000)).toBeGreaterThan(1000);
    });
});

describe("WIRE's two drawing paths", () => {
    async function started() {
        const { demo } = await import("../examples/wire/demo.js");
        const runtime = boot();
        runtime.run(demo);
        runtime.step(20);
        return runtime;
    }

    /** Frames between one finished picture and the next. */
    function timeOneImage(runtime: Awaited<ReturnType<typeof started>>): number {
        while (!runtime.gfx.busy) runtime.step();
        const start = runtime.frame;
        while (runtime.gfx.busy) runtime.step();
        return runtime.frame - start;
    }

    it("draws in software with nothing queued at all", async () => {
        const runtime = await started();
        expect(runtime.gfx.pending).toBe(0);
        runtime.step(5);
        expect(runtime.gfx.pending).toBe(0);
    });

    it("hands the same picture to the blitter when X is pressed", async () => {
        const runtime = await started();
        runtime.input.setButton(BUTTON.B, true);
        runtime.step(1);
        runtime.input.setButton(BUTTON.B, false);
        runtime.step(1);

        expect(runtime.gfx.pending).toBeGreaterThan(0);
        // A dozen frames a picture, against software's one - which is the
        // difference the demo exists to show.
        expect(timeOneImage(runtime)).toBeGreaterThan(6);
    });

    it("keeps drawing on the hidden page, so no half-drawn picture is shown", async () => {
        const runtime = await started();
        expect(runtime.screen.drawPage).not.toBe(runtime.screen.displayPage);

        runtime.input.setButton(BUTTON.B, true);
        runtime.step(1);
        runtime.input.setButton(BUTTON.B, false);

        // Through a whole picture and into the next, the page being painted is
        // never the page on screen.
        for (let i = 0; i < 40; ++i) {
            expect(runtime.screen.drawPage).not.toBe(runtime.screen.displayPage);
            runtime.step();
        }
    });

    it("goes back to software, and back to swapping pages", async () => {
        const runtime = await started();
        const press = () => {
            runtime.input.setButton(BUTTON.B, true);
            runtime.step(1);
            runtime.input.setButton(BUTTON.B, false);
            runtime.step(1);
        };

        press();
        expect(runtime.gfx.pending).toBeGreaterThan(0);

        // Pressing again abandons the half-drawn picture and goes back to
        // software, which queues nothing and swaps pages every frame.
        press();
        expect(runtime.gfx.pending).toBe(0);
        expect(runtime.screen.drawPage).not.toBe(runtime.screen.displayPage);
    });
});
