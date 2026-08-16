// Typed access to the AY-3-8910 (PSG).
//
// The chip has 16 registers reached through a latch: write the register number
// to port 0xA0, the value to port 0xA1. We keep the register file here and
// forward decoded values to the emulator, which is what the MSX's own PSG
// device does.

import type { PsgChip } from "../core/types.js";

/**
 * Tone generator clock. The MSX feeds the PSG half the CPU clock and the chip
 * divides by 16, so a period of N produces 112005/N Hz.
 */
export const TONE_CLOCK = 112005;

/** Register numbers. */
export const PSG_R = {
    TONE_A_LOW: 0, TONE_A_HIGH: 1,
    TONE_B_LOW: 2, TONE_B_HIGH: 3,
    TONE_C_LOW: 4, TONE_C_HIGH: 5,
    NOISE_PERIOD: 6,
    MIXER: 7,
    VOLUME_A: 8, VOLUME_B: 9, VOLUME_C: 10,
    ENVELOPE_LOW: 11, ENVELOPE_HIGH: 12,
    ENVELOPE_SHAPE: 13,
    IO_A: 14, IO_B: 15
} as const;

/** R7 bits. Each bit *disables* its generator, so 0x3F is total silence. */
export const MIXER = {
    TONE_A: 0x01, TONE_B: 0x02, TONE_C: 0x04,
    NOISE_A: 0x08, NOISE_B: 0x10, NOISE_C: 0x20
} as const;

/** R8-R10 bit 4: take the level from the envelope generator instead of bits 0-3. */
export const USE_ENVELOPE = 0x10;

/** R13 envelope shapes. Only the low 4 bits matter. */
export const ENVELOPE = {
    /** \| falling once, then silence. */
    DECAY: 0x00,
    /** /| rising once, then silence. */
    ATTACK: 0x04,
    /** \|\|\ sawtooth down, repeating. */
    SAW_DOWN: 0x08,
    /** \_ falling once, then hold at maximum. */
    DECAY_HOLD: 0x0b,
    /** /|/| sawtooth up, repeating. */
    SAW_UP: 0x0c,
    /** /‾ rising once, then hold at maximum. */
    ATTACK_HOLD: 0x0d,
    /** /\/\ triangle, repeating. */
    TRIANGLE: 0x0e
} as const;

export type Channel = 0 | 1 | 2;

export class Psg {
    private readonly regs = new Uint8Array(16);

    constructor(private readonly chip: PsgChip) {
        this.reset();
    }

    /** Writes a register, exactly as a write to ports 0xA0/0xA1 would. */
    write(reg: number, value: number): void {
        reg &= 0x0f;
        value &= 0xff;
        this.regs[reg] = value;

        switch (reg) {
            case 0: case 1:
                this.chip.setPeriodA(((this.regs[1] & 0x0f) << 8) | this.regs[0]); break;
            case 2: case 3:
                this.chip.setPeriodB(((this.regs[3] & 0x0f) << 8) | this.regs[2]); break;
            case 4: case 5:
                this.chip.setPeriodC(((this.regs[5] & 0x0f) << 8) | this.regs[4]); break;
            case 6:
                this.chip.setPeriodN(value & 0x1f); break;
            case 7:
                this.chip.setMixerControl(value); break;
            case 8:
                this.chip.setAmplitudeA(value); break;
            case 9:
                this.chip.setAmplitudeB(value); break;
            case 10:
                this.chip.setAmplitudeC(value); break;
            case 11: case 12:
                this.chip.setPeriodE((this.regs[12] << 8) | this.regs[11]); break;
            case 13:
                this.chip.setEnvelopeControl(value); break;
            // R14/R15 are the I/O ports: joysticks and the kana LED on a real
            // MSX. Nothing is wired to them here, but the register file keeps
            // them so reads stay consistent.
        }
    }

    read(reg: number): number {
        return this.regs[reg & 0x0f];
    }

    // --- Named controls ---------------------------------------------------

    /** Sets a channel's 12-bit tone period. Periods below 2 silence the tone. */
    setTonePeriod(channel: Channel, period: number): void {
        this.write(PSG_R.TONE_A_LOW + channel * 2, period & 0xff);
        this.write(PSG_R.TONE_A_HIGH + channel * 2, (period >> 8) & 0x0f);
    }

    /** Sets a channel's pitch in Hz, rounded to the nearest period the chip can express. */
    setTone(channel: Channel, hz: number): void {
        this.setTonePeriod(channel, hz > 0 ? Math.round(TONE_CLOCK / hz) : 0);
    }

    /** 0-15. Pass `useEnvelope` to hand the level to the envelope generator instead. */
    setVolume(channel: Channel, level: number, useEnvelope = false): void {
        this.write(PSG_R.VOLUME_A + channel, (level & 0x0f) | (useEnvelope ? USE_ENVELOPE : 0));
    }

    /** 5-bit noise period, shared by every channel that has noise enabled. */
    setNoisePeriod(period: number): void {
        this.write(PSG_R.NOISE_PERIOD, period & 0x1f);
    }

    /** Enables tone and/or noise per channel. Everything not listed is switched off. */
    setMixer(tone: readonly boolean[], noise: readonly boolean[] = [false, false, false]): void {
        let value = 0x3f;   // all disabled
        for (let ch = 0; ch < 3; ++ch) {
            if (tone[ch]) value &= ~(MIXER.TONE_A << ch);
            if (noise[ch]) value &= ~(MIXER.NOISE_A << ch);
        }
        this.write(PSG_R.MIXER, value);
    }

    /** Envelope period (16 bit) and shape. Shape writes always restart the envelope. */
    setEnvelope(period: number, shape: number): void {
        this.write(PSG_R.ENVELOPE_LOW, period & 0xff);
        this.write(PSG_R.ENVELOPE_HIGH, (period >> 8) & 0xff);
        this.write(PSG_R.ENVELOPE_SHAPE, shape & 0x0f);
    }

    /** Silences every channel without disturbing the tone periods. */
    silence(): void {
        this.setVolume(0, 0);
        this.setVolume(1, 0);
        this.setVolume(2, 0);
    }

    reset(): void {
        this.regs.fill(0);
        this.regs[PSG_R.IO_B] = 0x8f;    // matches the MSX power-on state
        this.chip.reset();
        this.write(PSG_R.MIXER, 0x3f);   // everything off
    }
}
