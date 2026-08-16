import { describe, expect, it } from "vitest";
import { FantasyMachine } from "../src/core/machine.js";
import { colorHistogram, countColor, framePixels } from "./helpers.js";

/** V9938 GRAPHIC4 (SCREEN 5): 256x212, 16 colors, 2 pixels per byte, 128 bytes per line. */
function setupScreen5(m: FantasyMachine): void {
    writeRegister(m, 0, 0x06);      // M3, M4 -> GRAPHIC4
    writeRegister(m, 1, 0x40);      // display enabled
    writeRegister(m, 2, 0x1f);      // pattern layout table at 0x00000 (page 0)
    writeRegister(m, 7, 0x00);      // backdrop color 0
}

/** Port 0x99 register write: value first, then 0x80 | register number. */
function writeRegister(m: FantasyMachine, reg: number, value: number): void {
    m.vdp.output99(value);
    m.vdp.output99(0x80 | reg);
}

/** Port 0x99 VRAM address setup for writing, then bytes through port 0x98. */
function setVramWriteAddress(m: FantasyMachine, address: number): void {
    writeRegister(m, 14, (address >> 14) & 0x07);
    m.vdp.output99(address & 0xff);
    m.vdp.output99(0x40 | ((address >> 8) & 0x3f));
}

describe("VDP running without a CPU", () => {
    it("produces a frame every videoClockPulse", () => {
        const m = new FantasyMachine();
        expect(m.getFrame()).toBeNull();

        m.frame();
        const frame = m.getFrame();
        expect(frame).not.toBeNull();
        expect(frame!.width).toBeGreaterThan(0);
        expect(frame!.height).toBeGreaterThan(0);
    });

    it("advances the cycle counter by one NTSC frame worth of CPU clocks", () => {
        const m = new FantasyMachine();
        m.frame();
        // 262 lines x 228 CPU cycles = 59736 cycles per NTSC frame.
        expect(m.cycles).toBe(59736);
    });

    it("renders VRAM contents to pixels in SCREEN 5", () => {
        const m = new FantasyMachine();
        setupScreen5(m);

        // Paint the top 16 lines white (color 15), two pixels per byte.
        setVramWriteAddress(m, 0x00000);
        for (let i = 0; i < 128 * 16; ++i) m.vdp.output98(0xff);

        m.frame();
        const pixels = framePixels(m.getFrame()!);

        const WHITE = 0xffffffff;
        // 256 wide x 16 lines, and the VDP renders each frame line once.
        expect(countColor(pixels, WHITE)).toBe(256 * 16);
    });

    it("shows the backdrop color through transparent pixels", () => {
        const m = new FantasyMachine();
        setupScreen5(m);
        writeRegister(m, 7, 0x06);      // backdrop = palette entry 6 (medium red)

        m.frame();
        const pixels = framePixels(m.getFrame()!);
        const histogram = colorHistogram(pixels);

        // VRAM is all zeros -> every active pixel is transparent -> backdrop everywhere.
        expect(histogram[0].color).not.toBe("0x00000000");
        expect(histogram[0].count).toBeGreaterThan(256 * 200);
    });
});
