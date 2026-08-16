import { describe, expect, it, vi } from "vitest";
import { createSystem, MODES, OP, R, R1, R9, S, S2 } from "../src/api/index.js";
import { Psg, PSG_R, TONE_CLOCK } from "../src/api/psg.js";
import { pitchToFrequency } from "../src/api/opll.js";
import type { PsgChip } from "../src/core/types.js";
import { activePixels, pixelAt } from "./helpers.js";

const WHITE = 0xffffffff;

/** Pitch error in cents - the only scale on which tuning error means anything. */
function centsOff(actual: number, expected: number): number {
    return Math.abs(1200 * Math.log2(actual / expected));
}

function screen5() {
    const s = createSystem();
    s.vdp.setMode("G4", 0);
    s.vdp.setDisplayEnabled(true);
    s.vdp.setBackdrop(1);       // black, so anything drawn stands out
    s.machine.frame();          // the new geometry takes effect at the next vsync
    return s;
}

describe("Vdp mode selection", () => {
    it("assembles the mode bits across R0 and R1", () => {
        const s = createSystem();
        s.vdp.setMode("G4");
        // GRAPHIC4 is mode bits 0x03: R0 bits 1-3 carry M3-M5, R1 bits 3-4 carry M1-M2.
        expect(s.vdp.read(R.MODE_0) & 0x0e).toBe(0x06);
        expect(s.vdp.read(R.MODE_1) & R1.MODE_MASK).toBe(0x00);
        expect(s.vdp.mode).toBe(MODES.G4);
    });

    it("selects 212 lines for the V9938 bitmap modes and 192 for the MSX1 modes", () => {
        const s = createSystem();
        s.vdp.setMode("G4");
        expect(s.vdp.read(R.MODE_3) & R9.LINES_212).toBe(R9.LINES_212);
        s.vdp.setMode("G2");
        expect(s.vdp.read(R.MODE_3) & R9.LINES_212).toBe(0);
    });

    it("moves the framebuffer when the page changes", () => {
        const s = createSystem();
        s.vdp.setMode("G4", 0);
        expect(s.vdp.tables.layout).toBe(0x00000);
        s.vdp.setMode("G4", 1);
        expect(s.vdp.tables.layout).toBe(0x08000);
        expect(s.vdp.lineAddress(2)).toBe(0x08000 + 2 * 128);
        // 128KB of VRAM holds four 32KB pages, and page numbers wrap.
        s.vdp.setMode("G4", 5);
        expect(s.vdp.page).toBe(1);
    });
});

describe("Vdp VRAM access", () => {
    it("gives the same result through the ports and through the array", () => {
        const s = createSystem();
        s.vdp.setWriteAddress(0x1234);
        s.vdp.writeData(0xa5);
        expect(s.vdp.vram[0x1234]).toBe(0xa5);

        s.vdp.vram[0x1235] = 0x5a;
        s.vdp.setReadAddress(0x1235);
        expect(s.vdp.readData()).toBe(0x5a);
    });

    it("reaches past the 16KB boundary an MSX1 was limited to", () => {
        const s = createSystem();
        s.vdp.setWriteAddress(0x1f000);
        s.vdp.writeData(0x77);
        expect(s.vdp.vram[0x1f000]).toBe(0x77);
    });
});

describe("Vdp command engine", () => {
    it("fills a rectangle where asked", () => {
        const s = screen5();
        s.vdp.cmd.fill(10, 20, 30, 8, 15);
        s.machine.frame();
        const frame = s.machine.getFrame()!;
        expect(s.vdp.cmd.busy).toBe(false);

        expect(pixelAt(frame, MODES.G4, 10, 20)).toBe(WHITE);
        expect(pixelAt(frame, MODES.G4, 39, 27)).toBe(WHITE);
        expect(pixelAt(frame, MODES.G4, 40, 20)).not.toBe(WHITE);
        expect(pixelAt(frame, MODES.G4, 10, 28)).not.toBe(WHITE);

        const { pixels } = activePixels(frame, MODES.G4);
        expect(pixels.filter((p) => p === WHITE).length).toBe(30 * 8);
    });

    it("works out the direction flags for a line between two points", () => {
        const s = screen5();
        s.vdp.cmd.lineTo(100, 100, 60, 80, 15);     // up and to the left, X major
        s.machine.frame();
        const frame = s.machine.getFrame()!;

        expect(pixelAt(frame, MODES.G4, 100, 100)).toBe(WHITE);
        expect(pixelAt(frame, MODES.G4, 60, 80)).toBe(WHITE);
        expect(pixelAt(frame, MODES.G4, 80, 90)).toBe(WHITE);
    });

    it("keeps CE raised for as long as the blit really takes", () => {
        const framesToFinish = (issue: () => void) => {
            const s = screen5();
            issue.call(s);
            expect(s.vdp.cmd.busy).toBe(true);
            expect(s.vdp.status(S.COMMAND) & S2.COMMAND_EXECUTING).toBe(S2.COMMAND_EXECUTING);
            let frames = 0;
            while (s.vdp.cmd.busy && frames < 200) { s.machine.frame(); ++frames; }
            return frames;
        };

        // A full-screen fill takes the V9938 a visible fraction of a second.
        // The byte-wise HMMV does the same work several times faster, which is
        // the trade the drawing library is built around.
        const pixelwise = framesToFinish(function (this: ReturnType<typeof screen5>) {
            this.vdp.cmd.fill(0, 0, 256, 212, 7);
        });
        const bytewise = framesToFinish(function (this: ReturnType<typeof screen5>) {
            this.vdp.cmd.fillBytes(0, 0, 128, 212, 0x77);
        });

        expect(pixelwise).toBeGreaterThan(10);
        expect(bytewise).toBeLessThan(pixelwise / 4);
    });

    it("honours the logical operations", () => {
        const s = screen5();
        s.vdp.cmd.fill(0, 0, 16, 16, 0b1111);
        s.machine.frame();
        s.vdp.cmd.fill(0, 0, 16, 16, 0b0110, OP.XOR);
        s.machine.frame();
        // 1111 XOR 0110 = 1001
        expect(s.vdp.vram[0] >> 4).toBe(0b1001);
    });
});

describe("Vdp palette", () => {
    it("changes what a colour index looks like on screen", () => {
        const s = screen5();
        s.vdp.cmd.fill(0, 0, 8, 8, 15);
        s.machine.frame();
        const before = pixelAt(s.machine.getFrame()!, MODES.G4, 0, 0);

        s.vdp.setPaletteEntry(15, 7, 0, 0);         // full red, no green, no blue
        s.machine.frame();
        const after = pixelAt(s.machine.getFrame()!, MODES.G4, 0, 0);

        expect(before).toBe(WHITE);
        expect(after).not.toBe(before);
        expect(after & 0x0000ff).toBe(0xff);        // red channel saturated
        expect(after & 0x00ff00).toBe(0);           // green off
    });
});

describe("Psg", () => {
    function fakeChip() {
        return {
            setPeriodA: vi.fn(), setPeriodB: vi.fn(), setPeriodC: vi.fn(),
            setPeriodN: vi.fn(), setPeriodE: vi.fn(),
            setAmplitudeA: vi.fn(), setAmplitudeB: vi.fn(), setAmplitudeC: vi.fn(),
            setMixerControl: vi.fn(), setEnvelopeControl: vi.fn(),
            setAudioSocket: vi.fn(), powerOn: vi.fn(), powerOff: vi.fn(), reset: vi.fn()
        } satisfies PsgChip;
    }

    it("assembles a 12-bit tone period from its two registers", () => {
        const chip = fakeChip();
        const psg = new Psg(chip);
        psg.write(PSG_R.TONE_A_LOW, 0x34);
        psg.write(PSG_R.TONE_A_HIGH, 0x02);
        expect(chip.setPeriodA).toHaveBeenLastCalledWith(0x234);
    });

    it("converts Hz to a tone period", () => {
        const chip = fakeChip();
        const psg = new Psg(chip);
        psg.setTone(0, 440);
        // 112005 / 440 = 254.6
        expect(chip.setPeriodA).toHaveBeenLastCalledWith(255);
        // Periods are integers, so pitch quantises. At 440 Hz the error is
        // about three cents - audible only against a reference, and exactly
        // what the hardware does.
        expect(centsOff(TONE_CLOCK / 255, 440)).toBeLessThan(5);
    });

    it("builds a mixer mask where a set bit means disabled", () => {
        const chip = fakeChip();
        const psg = new Psg(chip);
        psg.setMixer([true, false, false], [false, false, true]);
        // tone A on (bit 0 clear), noise C on (bit 5 clear), everything else off.
        expect(chip.setMixerControl).toHaveBeenLastCalledWith(0b011110);
    });

    it("routes a channel's level to the envelope generator when asked", () => {
        const chip = fakeChip();
        const psg = new Psg(chip);
        psg.setVolume(1, 0, true);
        expect(chip.setAmplitudeB).toHaveBeenLastCalledWith(0x10);
    });
});

describe("Opll", () => {
    it("picks the lowest block that keeps the F-number in nine bits", () => {
        for (const hz of [55, 110, 220, 440, 880, 1760]) {
            const { fnum, block } = pitchToFrequency(hz);
            expect(fnum).toBeLessThan(512);
            expect(block).toBeGreaterThanOrEqual(0);
            // Round-trip within a cent or so of the requested pitch.
            const back = (fnum * 49780 * (1 << block)) / (1 << 19);
            expect(centsOff(back, hz)).toBeLessThan(10);
        }
    });

    it("keeps key-on and sustain when only the pitch changes", () => {
        const s = createSystem();
        s.opll.play(0, 440, 3);
        s.opll.setSustain(0, true);
        const before = s.opll.read(0x20);
        s.opll.setPitch(0, 880);
        expect(s.opll.read(0x20) & 0x30).toBe(before & 0x30);
    });
});
