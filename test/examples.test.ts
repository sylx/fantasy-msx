import { describe, expect, it } from "vitest";
import {
    BUTTON, FONT, MOUSE, OPLL_R, RHYTHM, boot, charCells, glyphOffset,
    type Button, type Runtime, type TextRasteriser
} from "../src/index.js";
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

describe("the TYPE demo", () => {
    /**
     * A rasteriser standing in for the browser's: a monospaced face half as
     * wide as it is tall, whose coverage ramps across every 16 columns so that
     * moving the threshold moves a predictable amount of ink.
     */
    const stub: TextRasteriser = (text, style) => {
        const lines = text.split("\n");
        const longest = Math.max(...lines.map((line) => line.length));
        const width = Math.max(1, Math.round(longest * style.size * 0.5));
        const lineHeight = Math.round(style.lineHeight ?? style.size * 1.2);
        const height = Math.max(1, lineHeight * lines.length);

        const alpha = new Uint8Array(width * height);
        for (let y = 0; y < height; ++y) {
            for (let x = 0; x < width; ++x) alpha[y * width + x] = (x % 16) * 17;
        }
        return { width, height, alpha, baseline: Math.round(style.size * 0.8), lineHeight };
    };

    async function started(rasteriser: TextRasteriser | null = stub) {
        const { demo } = await import("../examples/type/demo.js");
        const runtime = boot();
        if (rasteriser) runtime.bios.text.rasteriser = rasteriser;
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

    /** How much of the sheet came out as ink, above the readout. */
    function ink(runtime: Awaited<ReturnType<typeof started>>): number {
        for (let i = 0; i < 100 && runtime.gfx.busy; ++i) runtime.step(1);
        let count = 0;
        for (let y = 0; y < runtime.screen.height - 18; ++y) {
            for (let x = 0; x < runtime.screen.width; x += 2) if (runtime.gfx.getPixel(x, y) === 1) ++count;
        }
        return count;
    }

    it("sets the sheet on paper of its own, and queues the display line", async () => {
        const runtime = await started();

        expect(runtime.screen.mode.name).toBe("G4");
        expect(runtime.screen.palette[0]).toEqual([7, 7, 5]);   // paper
        expect(runtime.screen.palette[1]).toEqual([0, 0, 1]);   // ink

        // The headline goes through the blitter; everything under it is written.
        expect(runtime.gfx.pending).toBe(1);
        expect(runtime.gfx.work).toBeGreaterThan(1000);
        expect(ink(runtime)).toBeGreaterThan(500);
    });

    /** How many of the sheet's pixels landed on each index, above the readout. */
    function counts(runtime: Awaited<ReturnType<typeof started>>): Map<number, number> {
        for (let i = 0; i < 100 && runtime.gfx.busy; ++i) runtime.step(1);
        const found = new Map<number, number>();
        for (let y = 0; y < runtime.screen.height - 18; ++y) {
            for (let x = 0; x < runtime.screen.width; ++x) {
                const index = runtime.gfx.getPixel(x, y);
                found.set(index, (found.get(index) ?? 0) + 1);
            }
        }
        return found;
    }

    it("spends the coverage on the ramp, and only on the entries the ramp names", async () => {
        const runtime = await started();
        // Three shades to start with: the two greys and the ink itself.
        const shaded = counts(runtime);
        for (const index of [4, 5, 1]) expect(shaded.get(index) ?? 0).toBeGreaterThan(20);
        expect(shaded.get(6) ?? 0).toBe(0);             // the fourth grey is not in this ramp

        // Down to a solid edge, and the greys go with it.
        press(runtime, BUTTON.UP);
        press(runtime, BUTTON.UP);
        const solid = counts(runtime);
        expect(solid.get(1) ?? 0).toBeGreaterThan(20);
        for (const index of [4, 5, 6]) expect(solid.get(index) ?? 0).toBe(0);

        // And on to the longest ramp, which reaches the fourth grey.
        press(runtime, BUTTON.DOWN);
        press(runtime, BUTTON.DOWN);
        press(runtime, BUTTON.DOWN);
        expect(counts(runtime).get(6) ?? 0).toBeGreaterThan(20);
    });

    it("wraps at both ends of the list of ramps", async () => {
        const runtime = await started();
        const solid = () => (counts(runtime).get(5) ?? 0) === 0;

        press(runtime, BUTTON.UP);
        press(runtime, BUTTON.UP);
        expect(solid()).toBe(true);
        press(runtime, BUTTON.UP);                      // past the top, round to the longest
        expect(solid()).toBe(false);
        press(runtime, BUTTON.DOWN);                    // and back again
        expect(solid()).toBe(true);
    });

    it("resets the sheet for each face and specimen", async () => {
        const runtime = await started();
        const widths = new Set<number>();

        for (const button of [BUTTON.RIGHT, BUTTON.B]) {
            press(runtime, button);
            // Each change abandons what was queued and starts the sheet again.
            expect(runtime.gfx.pending).toBe(1);
            widths.add(runtime.gfx.work);
            expect(ink(runtime)).toBeGreaterThan(0);
        }
        // The faces and the specimens are different widths, so the display
        // line is too.
        expect(widths.size).toBeGreaterThan(1);
    });

    it("sets the same sheet in SCREEN 7, twice as wide, and keeps its palette", async () => {
        const runtime = await started();
        const narrow = runtime.gfx.work;                // the display line, in SCREEN 5

        press(runtime, BUTTON.A);
        expect(runtime.screen.mode.name).toBe("G6");
        expect(runtime.screen.width).toBe(512);
        // The mode change would have taken the sheet's colours with it.
        expect(runtime.screen.palette[0]).toEqual([7, 7, 5]);
        expect(runtime.screen.palette[5]).toEqual([3, 3, 3]);

        // The em is drawn twice as wide, so the same line is twice the pixels:
        // type of the same shape, with twice the detail across it.
        expect(runtime.gfx.work).toBeGreaterThan(narrow * 1.8);
        expect(ink(runtime)).toBeGreaterThan(500);

        press(runtime, BUTTON.A);
        expect(runtime.screen.mode.name).toBe("G4");
    });

    it("says so and falls back to the ROM font where there is no text engine", async () => {
        const runtime = await started(null);       // headless: nothing to ask for a face

        expect(runtime.gfx.pending).toBe(0);       // no display line to queue
        // The apology is set in the machine's own font, so there is still ink.
        expect(ink(runtime)).toBeGreaterThan(50);
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

describe("the LOOM demo", () => {
    /** Rows of the desk, in the order they are drawn. */
    const ROW = { PAD: 0, LEAD: 1, BASS: 2, DRUM: 3, ARP: 4, ECHO: 5, HAT: 6 };
    const rowY = (row: number) => 134 + row * 11 + 5;
    const LAMP_X = 9;
    /** A level on a fader, in the pixel that lights that cell and no more. */
    const faderX = (level: number) => 100 + (level - 1) * 8 + 4;

    async function started(frames = 30) {
        const { demo } = await import("../examples/loom/demo.js");
        const runtime = boot();
        runtime.run(demo);
        runtime.step(frames);
        return runtime;
    }

    function click(runtime: Runtime, x: number, y: number): void {
        runtime.pointer.setPosition(x, y, true);
        runtime.pointer.setButton(MOUSE.LEFT, true);
        runtime.step(1);
        runtime.pointer.setButton(MOUSE.LEFT, false);
        runtime.step(1);
    }

    /**
     * The roll, read back off the screen as the picture of the phrase it is -
     * one string per column, so the playhead sweeping through it can be left
     * out of the comparison.
     */
    function roll(runtime: Runtime): string[] {
        const columns: string[] = [];
        for (let x = 4; x < 252; ++x) {
            let column = "";
            for (let y = 40; y < 130; y += 3) column += runtime.gfx.getPixel(x, y).toString(16);
            columns.push(column);
        }
        return columns;
    }

    /** How many columns of the roll differ. Two is the playhead in each sample. */
    function differences(before: string[], after: string[]): number {
        let count = 0;
        for (let i = 0; i < before.length; ++i) if (before[i] !== after[i]) ++count;
        return count;
    }

    /**
     * Runs frames, reporting which OPLL channels were keyed on during them.
     * The demo writes its own registers rather than playing a song, so this is
     * the only place its notes can be observed.
     */
    function keyed(runtime: Runtime, frames: number): Set<number> {
        const { opll } = runtime.bios.system;
        const seen = new Set<number>();
        for (let i = 0; i < frames; ++i) {
            runtime.step(1);
            for (let channel = 0; channel < 6; ++channel) {
                if (opll.read(OPLL_R.BLOCK + channel) & 0x10) seen.add(channel);
            }
        }
        return seen;
    }

    it("runs in SCREEN 5 with both chips going and the OPLL in rhythm mode", async () => {
        const runtime = await started();

        expect(runtime.screen.mode.name).toBe("G4");
        expect(runtime.bios.system.machine.getAudioSignals()).toHaveLength(2);
        // Rhythm mode trades the last three FM voices for five drums.
        expect(runtime.bios.system.opll.read(OPLL_R.RHYTHM) & RHYTHM.ENABLE).toBe(RHYTHM.ENABLE);
        // Nothing is playing a song: the sequencer writes the registers itself.
        expect(runtime.bgm.playing).toBe(false);
    });

    it("plays a voice for each note of the chord, and one each for the lead and the bass", async () => {
        const runtime = await started();
        const heard = keyed(runtime, 240);
        // Three for a triad, four when the chord has a seventh on it - which is
        // why the fourth pad channel is not asked for here.
        for (const channel of [0, 1, 2, 4, 5]) expect(heard.has(channel)).toBe(true);
    });

    it("gives the drums a pitch, without which the chip's percussion is silent", async () => {
        const runtime = await started();
        const { opll } = runtime.bios.system;
        for (const channel of [6, 7, 8]) {
            expect(opll.read(OPLL_R.FNUM_LOW + channel) | (opll.read(OPLL_R.BLOCK + channel) & 1) << 8)
                .toBeGreaterThan(0);
        }
    });

    it("mutes a part where it stands, and lets it back in", async () => {
        const runtime = await started();

        click(runtime, LAMP_X, rowY(ROW.PAD));
        const muted = keyed(runtime, 240);
        expect([...muted].some((channel) => channel <= 3)).toBe(false);
        expect(muted.has(4)).toBe(true);            // the lead is still going

        click(runtime, LAMP_X, rowY(ROW.PAD));
        expect([...keyed(runtime, 240)].some((channel) => channel <= 3)).toBe(true);
    });

    it("writes a fader straight into the chip's attenuation", async () => {
        const runtime = await started();
        const { opll } = runtime.bios.system;
        // The OPLL counts down from loudest, so a level of 4 is an attenuation
        // of 11 - or 12, since a note off the beat is written a step quieter.
        const level = () => 15 - (opll.read(OPLL_R.INSTRUMENT + 4) & 0x0f);

        click(runtime, faderX(4), rowY(ROW.LEAD));
        runtime.step(20);
        expect(level()).toBeGreaterThanOrEqual(3);
        expect(level()).toBeLessThanOrEqual(4);

        click(runtime, faderX(15), rowY(ROW.LEAD));
        runtime.step(20);
        expect(level()).toBeGreaterThanOrEqual(14);
    });

    it("drags a fader with the button held, wherever the mouse goes", async () => {
        const runtime = await started();
        const { opll } = runtime.bios.system;

        runtime.pointer.setPosition(faderX(10), rowY(ROW.BASS), true);
        runtime.pointer.setButton(MOUSE.LEFT, true);
        runtime.step(2);
        // Off the bottom of the screen, still holding: the drag keeps the fader.
        runtime.pointer.setPosition(faderX(2), 400, false);
        runtime.step(40);
        const quiet = opll.read(OPLL_R.INSTRUMENT + 5) & 0x0f;
        expect(quiet).toBeGreaterThanOrEqual(13);

        runtime.pointer.setButton(MOUSE.LEFT, false);
        runtime.step(2);
        // Let go, and the same place on the screen no longer moves it.
        runtime.pointer.setPosition(faderX(14), 400, false);
        runtime.step(40);
        expect(opll.read(OPLL_R.INSTRUMENT + 5) & 0x0f).toBe(quiet);
    });

    it("changes an instrument from its cell, one arrow each way", async () => {
        const runtime = await started();
        const { opll } = runtime.bios.system;
        const patch = () => opll.read(OPLL_R.INSTRUMENT + 4) >> 4;

        runtime.step(30);
        const before = patch();
        click(runtime, 90, rowY(ROW.LEAD));         // the right-hand arrow
        runtime.step(30);
        expect(patch()).toBe((before + 1) % 16);

        click(runtime, 50, rowY(ROW.LEAD));         // and back
        runtime.step(30);
        expect(patch()).toBe(before);
    });

    it("re-rolls the drums for a new groove and leaves the rest of the phrase alone", async () => {
        const runtime = await started(120);
        /** The note field alone, above the rule the drum lanes hang under. */
        const notes = () => roll(runtime).map((column) => column.slice(0, 25));
        /** And the drum lanes alone. */
        const drums = () => {
            let out = "";
            for (let y = 119; y < 130; ++y) {
                for (let x = 4; x < 252; ++x) out += runtime.gfx.getPixel(x, y).toString(16);
            }
            return out;
        };

        const before = notes();
        const beat = drums();
        click(runtime, 90, rowY(ROW.DRUM));         // the next groove
        runtime.step(2);

        expect(drums()).not.toBe(beat);
        expect(differences(before, notes())).toBeLessThanOrEqual(2);
    });

    it("writes a different phrase on NEW, and draws it", async () => {
        const runtime = await started(120);
        const before = roll(runtime);

        click(runtime, 238, 4);
        runtime.step(2);
        expect(differences(before, roll(runtime))).toBeGreaterThan(20);
    });

    it("leaves the phrase alone for as long as it is playing", async () => {
        const runtime = await started(120);
        click(runtime, 150, 4);                     // AUTO off

        const before = roll(runtime);
        runtime.step(600);
        expect(differences(before, roll(runtime))).toBeLessThanOrEqual(2);
    });

    it("changes it by itself when it is left to, at the turn of the phrase", async () => {
        const runtime = await started(120);
        const before = roll(runtime);

        // A phrase is 128 sixteenths; the opening one is at 96, where that is
        // 1200 frames. Nothing may change before the end of it.
        runtime.step(900);
        expect(differences(before, roll(runtime))).toBeLessThanOrEqual(2);
        runtime.step(400);
        expect(differences(before, roll(runtime))).toBeGreaterThan(20);
    });

    it("puts the cursor under the mouse, and takes it away when the mouse leaves", async () => {
        const runtime = await started();
        const { vram } = runtime.bios.system.vdp;
        const attributes = runtime.screen.spriteTables.attributes;

        runtime.pointer.setPosition(120, 80, true);
        runtime.step(1);
        // The VDP draws a sprite one line below its stored Y, and the shadow
        // is the same arrow a pixel down and across.
        expect(vram[attributes + 1]).toBe(120);
        expect(vram[attributes]).toBe(79);
        expect(vram[attributes + 5]).toBe(121);

        runtime.pointer.setPosition(300, 80, false);
        runtime.step(1);
        expect(vram[attributes]).toBeGreaterThan(211);
    });

    it("works the same desk from a joystick, for a machine with no mouse", async () => {
        const runtime = await started();
        const { opll } = runtime.bios.system;

        // Down to the bass, then hold left: the fader sweeps to silence.
        for (let i = 0; i < 2; ++i) {
            runtime.input.setButton(BUTTON.DOWN, true);
            runtime.step(1);
            runtime.input.setButton(BUTTON.DOWN, false);
            runtime.step(1);
        }
        runtime.input.setButton(BUTTON.LEFT, true);
        runtime.step(80);
        runtime.input.setButton(BUTTON.LEFT, false);
        runtime.step(4);
        expect(opll.read(OPLL_R.INSTRUMENT + 5) & 0x0f).toBe(15);
    });
});

describe("the EDITOR demo", () => {
    async function started(): Promise<Runtime> {
        const { demo } = await import("../examples/editor/demo.js");
        const runtime = boot();
        runtime.run(demo);
        runtime.step(1);
        return runtime;
    }

    it("lays an 85 by 26 grid over SCREEN 7 and captures the keyboard", async () => {
        const runtime = await started();
        expect(runtime.screen.mode.name).toBe("G6");
        expect(runtime.console.cols).toBe(85);
        expect(runtime.console.rows).toBe(26);
        // Typed into rather than played: Z is a letter, not a trigger.
        expect(runtime.keyboard.capturing).toBe(true);
        expect(runtime.input.typing).toBe(true);
    });

    it("types into the document, at the caret", async () => {
        const runtime = await started();
        runtime.keyboard.press({ code: "End", key: "End" });
        runtime.step(1);
        runtime.keyboard.type("!!");
        runtime.step(1);

        // The gutter is four digits and a rule, so the text starts at column 5.
        expect(runtime.console.rowText(1).slice(5).trimEnd()).toBe("FANTASY MSX - EDITOR!!");
        expect(runtime.console.rowText(0)).toContain("*");        // and it says so
    });

    it("splits and joins lines, and moves the caret to the seam", async () => {
        const runtime = await started();
        for (const key of ["ArrowRight", "ArrowRight", "ArrowRight", "Enter"]) {
            runtime.keyboard.press({ code: key, key });
            runtime.step(1);
        }
        expect(runtime.console.rowText(1).slice(5).trimEnd()).toBe("FAN");
        expect(runtime.console.rowText(2).slice(5).trimEnd()).toBe("TASY MSX - EDITOR");

        runtime.keyboard.press({ code: "Backspace", key: "Backspace" });
        runtime.step(1);
        expect(runtime.console.rowText(1).slice(5).trimEnd()).toBe("FANTASY MSX - EDITOR");
    });

    it("scrolls the view by moving pixels, not by repainting the page", async () => {
        const runtime = await started();
        const term = runtime.console;
        const press = (key: string) => {
            runtime.keyboard.press({ code: key, key });
            runtime.step(1);
        };

        // The view is twenty-four rows, so the twenty-fourth arrow down is the
        // first one that has to move it.
        for (let i = 0; i < 23; ++i) press("ArrowDown");
        expect(term.repainted).toBeLessThan(term.cols);

        press("ArrowDown");
        // One row uncovered, plus the caret and the line number under it. The
        // twenty-three rows that moved were copied, not drawn.
        expect(term.repainted).toBeGreaterThanOrEqual(term.cols);
        expect(term.repainted).toBeLessThan(term.cols * 2);
    });

    it("costs four cells to add a character to the end of a line", async () => {
        const runtime = await started();
        runtime.keyboard.press({ code: "End", key: "End" });
        runtime.step(2);
        runtime.keyboard.type("x");                          // the first edit also
        runtime.step(1);                                     // brings up MODIFIED

        runtime.keyboard.type("y");
        runtime.step(1);
        // The letter, the cell the caret came off, and two digits in the bar.
        expect(runtime.console.repainted).toBe(4);
    });

    it("costs the rest of the line to insert one in the middle of it", async () => {
        const runtime = await started();
        runtime.keyboard.type("x");                          // settle the marker first
        runtime.step(2);

        runtime.keyboard.press({ code: "Home", key: "Home" });
        runtime.step(2);
        runtime.keyboard.type("z");
        runtime.step(1);
        // "FANTASY MSX - EDITORx" moved along by one, and that is what it cost.
        expect(runtime.console.repainted).toBeGreaterThan(20);
    });
});

describe("the KANJI demo", () => {
    /**
     * A rasteriser standing in for the browser's. Every glyph is a filled box
     * an em wide for the full-width characters and half that for the rest, so
     * the atlas has something to measure and the grid has something to hold.
     */
    const stub: TextRasteriser = (text, style) => {
        const wide = charCells(text.codePointAt(0) ?? 32) === 2;
        const em = Math.max(2, Math.round(style.size * style.stretch));
        const width = wide ? em : Math.max(1, em >> 1);
        const height = Math.max(2, Math.round(style.size * 1.4));
        const alpha = new Uint8Array(width * height);
        const top = Math.round(style.size * 0.2);
        const bottom = Math.min(height, top + Math.round(style.size));
        for (let y = top; y < bottom; ++y) alpha.fill(255, y * width, (y + 1) * width);
        return { width, height, alpha, baseline: Math.round(style.size), lineHeight: height };
    };

    async function started(rasteriser: TextRasteriser | null = stub): Promise<Runtime> {
        const { demo } = await import("../examples/kanji/demo.js");
        const runtime = boot();
        if (rasteriser) runtime.bios.text.rasteriser = rasteriser;
        runtime.run(demo);
        runtime.step(2);
        return runtime;
    }

    function press(runtime: Runtime, button: Button): void {
        runtime.input.setButton(button, true);
        runtime.step(1);
        runtime.input.setButton(button, false);
        runtime.step(1);
    }

    it("sets sixteen full-width characters across SCREEN 7", async () => {
        const runtime = await started();
        expect(runtime.screen.mode.name).toBe("G6");
        // 32 half-width cells, which is 16 kanji - the same sixteen a 256-pixel
        // screen leaves room for, at twice the detail.
        expect(runtime.console.cols).toBe(32);
        expect(runtime.console.rows).toBe(13);
    });

    it("puts the passage on the screen, kanji and all", async () => {
        const runtime = await started();
        expect(runtime.console.rowText(1)).toContain("この画面に文字モードは");
        expect(runtime.console.rowText(0)).toContain("かな漢字");
    });

    it("keeps the glyphs in a page nothing is drawn on", async () => {
        const runtime = await started();
        const { vram } = runtime.bios.system.vdp;
        const page1 = runtime.screen.pageBase(1);

        let ink = 0;
        for (let i = page1; i < page1 + 8192; ++i) if (vram[i] !== 0) ++ink;
        expect(ink).toBeGreaterThan(0);
        // And the app is drawing on page 0, which is the one being shown.
        expect(runtime.screen.drawPage).toBe(0);
        expect(runtime.screen.displayPage).toBe(0);
    });

    it("shows that page when asked, and lends the levels a colour to do it", async () => {
        const runtime = await started();
        // Nothing in the page is index 15 - it holds levels - so entry 1 has to
        // become visible before the page is worth looking at.
        const before = runtime.screen.palette[1];

        press(runtime, BUTTON.B);
        expect(runtime.screen.displayPage).toBe(1);
        expect(runtime.screen.palette[1]).not.toEqual(before);

        press(runtime, BUTTON.B);
        expect(runtime.screen.displayPage).toBe(0);
        expect(runtime.screen.palette[1]).toEqual(before);
    });

    it("re-cuts the glyphs when the cell size changes", async () => {
        const runtime = await started();
        const wide = runtime.console.cols;

        press(runtime, BUTTON.DOWN);                  // a smaller cell
        expect(runtime.console.cols).toBeGreaterThan(wide);
        expect(runtime.console.rowText(1)).toContain("この画面");

        press(runtime, BUTTON.UP);
        press(runtime, BUTTON.UP);                    // and a larger one
        expect(runtime.console.cols).toBeLessThan(wide);
    });

    it("says so rather than throwing when there is no rasteriser", async () => {
        // Outside a browser there is nothing to ask for a glyph, which is the
        // gap the atlas exists to fill - so it has to fail legibly.
        const runtime = await started(null);
        expect(() => runtime.step(5)).not.toThrow();
        expect(runtime.bios.system.machine.getFrame()).not.toBeNull();
    });
});

describe("the IME demo", () => {
    async function started(): Promise<Runtime> {
        const { demo } = await import("../examples/ime/demo.js");
        const runtime = boot();
        runtime.bios.text.rasteriser = (text, style) => {
            const em = Math.max(2, Math.round(style.size * style.stretch));
            const width = charCells(text.codePointAt(0) ?? 32) === 2 ? em : Math.max(1, em >> 1);
            const height = Math.max(2, Math.round(style.size * 1.4));
            const alpha = new Uint8Array(width * height);
            const top = Math.round(style.size * 0.2);
            for (let y = top; y < Math.min(height, top + style.size); ++y) {
                alpha.fill(255, y * width, (y + 1) * width);
            }
            return { width, height, alpha, baseline: Math.round(style.size), lineHeight: height };
        };
        runtime.run(demo);
        runtime.step(2);
        return runtime;
    }

    it("captures the keyboard and asks before spending fifteen megabytes", async () => {
        const runtime = await started();
        expect(runtime.keyboard.capturing).toBe(true);
        expect(runtime.ime.attached).toBe(false);
        // Nothing is fetched until Z is pressed, and the screen says as much.
        expect(runtime.console.rowText(runtime.console.rows - 2)).toContain("辞書を読む");
    });

    it("types straight into the sheet while no engine is attached", async () => {
        const runtime = await started();
        runtime.keyboard.type("hello");
        runtime.step(2);
        expect(runtime.console.rowText(1)).toContain("hello");
    });

    it("draws the preedit and the candidate bar from what a session reports", async () => {
        const runtime = await started();
        // The engine is a seam: this is what hechima would have said.
        runtime.ime.attach((cb) => {
            cb.show([
                { text: "日本語", kind: "focus", candidates: ["日本語", "ニホンゴ", "にほんご"], candidateIndex: 0 },
                { text: "入力", kind: "other" }
            ]);
            return { feed: () => true, setActive: (on) => on, reset: () => {} };
        });
        runtime.ime.enabled = true;
        runtime.step(2);

        expect(runtime.console.rowText(1)).toContain("日本語入力");
        const bar = runtime.console.rowText(runtime.console.rows - 1);
        expect(bar).toContain("1:日本語");
        expect(bar).toContain("2:ニホンゴ");
    });
});
