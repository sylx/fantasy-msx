import { describe, expect, it } from "vitest";
import { BUTTON, FONT, boot, glyphOffset, type Button } from "../src/index.js";
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

describe("the TONE demo", () => {
    async function started() {
        const { demo } = await import("../examples/tone/demo.js");
        const runtime = boot();
        runtime.run(demo);
        runtime.step(2);
        return runtime;
    }

    function press(runtime: Awaited<ReturnType<typeof started>>, button: Button): void {
        runtime.input.setButton(button, true);
        runtime.step(1);
        runtime.input.setButton(button, false);
        runtime.step(1);
    }

    /** Runs until the blitter has laid the whole picture down. */
    function settle(runtime: Awaited<ReturnType<typeof started>>): void {
        for (let i = 0; i < 400 && runtime.gfx.busy; ++i) runtime.step(1);
    }

    it("walks the four bitmap modes with left and right, and wraps both ways", async () => {
        const runtime = await started();
        expect(runtime.screen.mode.name).toBe("G4");

        for (const name of ["G5", "G6", "G7", "G4"]) {
            press(runtime, BUTTON.RIGHT);
            expect(runtime.screen.mode.name).toBe(name);
        }
        for (const name of ["G7", "G6", "G5", "G4"]) {
            press(runtime, BUTTON.LEFT);
            expect(runtime.screen.mode.name).toBe(name);
        }
    });

    it("reduces the generated picture with nothing to fetch, and queues it", async () => {
        const runtime = await started();
        press(runtime, BUTTON.B);               // the chart, which needs no decoder

        // A screenful of pixels, handed to the blitter rather than written.
        expect(runtime.gfx.pending).toBe(1);
        expect(runtime.gfx.work).toBeGreaterThan(30000);

        settle(runtime);
        expect(runtime.gfx.busy).toBe(false);
        // Sixteen colours in play means a reduction happened, not a fill.
        const used = new Set<number>();
        for (let x = 0; x < 200; ++x) used.add(runtime.gfx.getPixel(x, 90));
        expect(used.size).toBeGreaterThan(6);
    });

    it("abandons a half-drawn picture when the mode changes under it", async () => {
        const runtime = await started();
        press(runtime, BUTTON.B);
        runtime.step(4);
        const drained = runtime.gfx.work;
        expect(drained).toBeGreaterThan(0);

        // Out to SCREEN 6 and back: the old job is dropped, not resumed.
        press(runtime, BUTTON.RIGHT);
        press(runtime, BUTTON.LEFT);
        expect(runtime.screen.mode.name).toBe("G4");
        expect(runtime.gfx.pending).toBe(1);
        expect(runtime.gfx.work).toBeGreaterThan(drained);
    });

    it("keeps two palette entries back for the readout where it can afford to", async () => {
        const runtime = await started();
        press(runtime, BUTTON.B);
        expect(runtime.screen.palette[0]).toEqual([0, 0, 0]);
        expect(runtime.screen.palette[1]).toEqual([7, 7, 7]);

        // SCREEN 6 has four colours and cannot spare two of them.
        press(runtime, BUTTON.RIGHT);
        expect(runtime.screen.mode.name).toBe("G5");
        expect(runtime.screen.palette.slice(0, 4)).not.toContainEqual([7, 7, 7]);
    });

    it("shows a picture dropped on the screen", async () => {
        const runtime = await started();
        // A red square, standing in for whatever the browser would have decoded.
        const red = new Uint8ClampedArray(64 * 64 * 4);
        for (let i = 0; i < 64 * 64; ++i) red.set([255, 0, 0, 255], i * 4);
        runtime.bios.image.decoder = async () => ({ width: 64, height: 64, data: red });

        await runtime.drop([{
            name: "sunset.jpg", type: "image/jpeg", size: 16, url: "blob:whatever",
            bytes: async () => new Uint8Array(), text: async () => ""
        }]);
        runtime.step(2);
        settle(runtime);

        // The palette was chosen for it, around the two entries held back.
        expect(runtime.screen.palette[2]).toEqual([7, 0, 0]);

        // And it is on screen: a square fitted to the 192 lines above the
        // readout, centred in the 256 across, with paper either side.
        const left = (256 - 192) >> 1;
        expect(runtime.gfx.getPixel(left, 0)).toBe(2);
        expect(runtime.gfx.getPixel(left + 191, 191)).toBe(2);
        expect(runtime.gfx.getPixel(left - 1, 96)).toBe(0);
    });

    it("says so, and still switches modes, when there is no decoder to fetch with", async () => {
        // Headless is exactly that case: no createImageBitmap to ask.
        const runtime = await started();
        await Promise.resolve();
        runtime.step(2);

        expect(runtime.gfx.pending).toBe(0);        // nothing to draw yet
        press(runtime, BUTTON.RIGHT);
        expect(runtime.screen.mode.name).toBe("G5");
    });
});

describe("the HAZE demo", () => {
    const PATTERN_TABLE = 0x0000;
    const PATTERN_BYTES = 2048;
    const SPRITE_ATTRIBUTES = 0x1c00;
    const SPRITE_PATTERNS = 0x2000;
    /** Screen line the readout is meant to stay on, whatever the scroll does. */
    const STATUS_TOP = 176;

    async function started(frames = 30) {
        const { demo } = await import("../examples/haze/demo.js");
        const runtime = boot();
        runtime.run(demo);
        runtime.step(frames);
        return runtime;
    }

    /**
     * Reads the eight-character readout back out of the sprite patterns, by
     * matching each character against the font it was drawn from. The demo
     * packs two characters into every 16x16 sprite, six pixels apart.
     */
    function readout(vram: Uint8Array): string {
        const rows = (pattern: number, right: boolean): number[] => {
            const out: number[] = [];
            for (let k = 0; k < 8; ++k) {
                const bits = (vram[pattern + 4 + k] << 8) | vram[pattern + 16 + 4 + k];
                out.push((right ? bits >> 2 : bits >> 8) & 0xf8);
            }
            return out;
        };

        let text = "";
        for (let sprite = 0; sprite < 4; ++sprite) {
            for (const right of [false, true]) {
                const glyph = rows(SPRITE_PATTERNS + sprite * 32, right);
                let found = " ";
                for (let code = 32; code < 127; ++code) {
                    const offset = glyphOffset(code);
                    if (glyph.every((bits, k) => bits === (FONT[offset + k] & 0xf8))) {
                        found = String.fromCharCode(code);
                        break;
                    }
                }
                text += found;
            }
        }
        return text;
    }

    it("runs in SCREEN 3, with both chips going", async () => {
        const runtime = await started();

        expect(runtime.screen.mode.name).toBe("MC");
        expect(runtime.screen.mode.screen).toBe(3);
        expect(runtime.screen.width).toBe(256);
        expect(runtime.screen.height).toBe(192);
        expect(runtime.bgm.playing).toBe(true);
        expect(runtime.bios.system.machine.getAudioSignals()).toHaveLength(2);
    });

    it("rewrites the whole picture every frame and queues nothing", async () => {
        const runtime = await started();
        const vram = runtime.bios.system.vdp.vram;

        const before = vram.slice(PATTERN_TABLE, PATTERN_TABLE + PATTERN_BYTES);
        runtime.step(1);
        const after = vram.slice(PATTERN_TABLE, PATTERN_TABLE + PATTERN_BYTES);

        expect(after).not.toEqual(before);
        // Every byte is rewritten, and a good third of them land on a different
        // colour from the frame before: a moving picture, not a corner touched up.
        let changed = 0;
        for (let i = 0; i < PATTERN_BYTES; ++i) if (before[i] !== after[i]) ++changed;
        expect(changed).toBeGreaterThan(PATTERN_BYTES / 4);

        // Nothing is handed to the blitter, which could not reach this mode anyway.
        expect(runtime.gfx.pending).toBe(0);
    });

    it("shows the pattern's name in four sprites, and stops the VDP after them", async () => {
        const runtime = await started();
        const vram = runtime.bios.system.vdp.vram;

        expect(readout(vram).trimEnd()).toMatch(/^PLASMA/);
        // The fifth attribute ends the list, so a line never carries more than
        // the four sprites this mode will draw.
        expect(vram[SPRITE_ATTRIBUTES + 16]).toBe(208);
    });

    it("moves on by itself every four bars, and on X without waiting", async () => {
        const runtime = await started(4 * 4 * 24 + 50);
        const vram = runtime.bios.system.vdp.vram;
        expect(readout(vram).trimEnd()).toMatch(/^VORTEX/);

        runtime.input.setButton(BUTTON.B, true);
        runtime.step(1);
        runtime.input.setButton(BUTTON.B, false);
        runtime.step(50);
        expect(readout(vram).trimEnd()).toMatch(/^MOIRE/);
    });

    it("scrolls the display without letting the readout scroll with it", async () => {
        const runtime = await started(10);
        const { vdp } = runtime.bios.system;

        const scrolls = new Set<number>();
        for (let i = 0; i < 60; ++i) {
            runtime.step(1);
            scrolls.add(vdp.read(23));
            // R23 offsets sprites too, so the demo adds it back. The line the
            // readout actually lands on is its stored Y plus one, less R23 -
            // give or take the single line it steps to avoid a Y of 208, which
            // would tell the VDP there were no sprites at all.
            const line = (vdp.vram[SPRITE_ATTRIBUTES] + 1 - vdp.read(23)) & 0xff;
            expect(line).toBeGreaterThanOrEqual(STATUS_TOP);
            expect(line).toBeLessThanOrEqual(STATUS_TOP + 1);
        }
        expect(scrolls.size).toBeGreaterThan(20);
    });
});
