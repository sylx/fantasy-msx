// Typed access to the YM2413 (OPLL), the FM chip in MSX-MUSIC / FM-PAC.
//
// Nine melody channels of 2-operator FM, or six melody channels plus five
// rhythm instruments. Only one channel can use a custom patch at a time; the
// other fifteen instruments are baked into the chip's ROM.

import type { OpllChip } from "../core/types.js";

/** The rate the chip generates samples at: main clock / 72. */
export const SAMPLE_RATE = 49780;

export const OPLL_R = {
    /** R0-R7: parameters of the one user-definable instrument. */
    CUSTOM: 0x00,
    /** R14: rhythm mode and the five drum triggers. */
    RHYTHM: 0x0e,
    /** R16-R24: F-number low 8 bits, one per channel. */
    FNUM_LOW: 0x10,
    /** R32-R40: F-number bit 8, block, key-on, sustain. */
    BLOCK: 0x20,
    /** R48-R56: instrument number and volume. */
    INSTRUMENT: 0x30
} as const;

/** R32+ bits. */
export const BLOCK_BITS = {
    FNUM_HIGH: 0x01,
    BLOCK_MASK: 0x0e,       // octave, 0-7
    KEY_ON: 0x10,
    SUSTAIN: 0x20
} as const;

/** R14 bits. */
export const RHYTHM = {
    ENABLE: 0x20,
    BASS_DRUM: 0x10,
    SNARE_DRUM: 0x08,
    TOM_TOM: 0x04,
    CYMBAL: 0x02,
    HI_HAT: 0x01
} as const;

/** The chip's built-in instruments. 0 selects the custom patch in R0-R7. */
export const INSTRUMENT = {
    CUSTOM: 0,
    VIOLIN: 1,
    GUITAR: 2,
    PIANO: 3,
    FLUTE: 4,
    CLARINET: 5,
    OBOE: 6,
    TRUMPET: 7,
    ORGAN: 8,
    HORN: 9,
    SYNTHESIZER: 10,
    HARPSICHORD: 11,
    VIBRAPHONE: 12,
    SYNTHESIZER_BASS: 13,
    ACOUSTIC_BASS: 14,
    ELECTRIC_GUITAR: 15
} as const;

/** Melody channels. In rhythm mode only 0-5 are available. */
export type OpllChannel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export class Opll {
    private readonly regs = new Uint8Array(0x40);

    constructor(private readonly chip: OpllChip) {}

    /** Writes a register, exactly as a write to ports 0x7C/0x7D would. */
    write(reg: number, value: number): void {
        this.regs[reg & 0x3f] = value & 0xff;
        this.chip.output7C(reg & 0x3f);
        this.chip.output7D(value & 0xff);
    }

    read(reg: number): number {
        return this.regs[reg & 0x3f];
    }

    // --- Named controls ---------------------------------------------------

    /** Instrument 0-15 and attenuation 0-15, where 0 is loudest. */
    setInstrument(channel: OpllChannel, instrument: number, volume: number): void {
        this.write(OPLL_R.INSTRUMENT + channel, ((instrument & 0x0f) << 4) | (volume & 0x0f));
    }

    setVolume(channel: OpllChannel, volume: number): void {
        this.write(OPLL_R.INSTRUMENT + channel, (this.regs[OPLL_R.INSTRUMENT + channel] & 0xf0) | (volume & 0x0f));
    }

    /** Sets pitch as a raw F-number (9 bits) and block (octave, 0-7). */
    setFrequency(channel: OpllChannel, fnum: number, block: number): void {
        this.write(OPLL_R.FNUM_LOW + channel, fnum & 0xff);
        const keep = this.regs[OPLL_R.BLOCK + channel] & (BLOCK_BITS.KEY_ON | BLOCK_BITS.SUSTAIN);
        this.write(OPLL_R.BLOCK + channel, keep | ((block & 0x07) << 1) | ((fnum >> 8) & 0x01));
    }

    /** Sets pitch in Hz, choosing the block that keeps the F-number in its precise range. */
    setPitch(channel: OpllChannel, hz: number): void {
        const { fnum, block } = pitchToFrequency(hz);
        this.setFrequency(channel, fnum, block);
    }

    /** Starts (or releases) a note. Pitch and instrument must already be set. */
    setKeyOn(channel: OpllChannel, on: boolean): void {
        const reg = OPLL_R.BLOCK + channel;
        this.write(reg, on ? this.regs[reg] | BLOCK_BITS.KEY_ON : this.regs[reg] & ~BLOCK_BITS.KEY_ON);
    }

    /** Sustain holds the note at its sustain level after key-off instead of releasing. */
    setSustain(channel: OpllChannel, on: boolean): void {
        const reg = OPLL_R.BLOCK + channel;
        this.write(reg, on ? this.regs[reg] | BLOCK_BITS.SUSTAIN : this.regs[reg] & ~BLOCK_BITS.SUSTAIN);
    }

    /** Convenience: set instrument, pitch and volume, then key on. */
    play(channel: OpllChannel, hz: number, instrument: number, volume = 0): void {
        this.setKeyOn(channel, false);
        this.setInstrument(channel, instrument, volume);
        this.setPitch(channel, hz);
        this.setKeyOn(channel, true);
    }

    /**
     * Turns rhythm mode on, which converts channels 6-8 into five percussion
     * voices. Their volumes live in R54-R56.
     */
    setRhythmMode(on: boolean): void {
        this.write(OPLL_R.RHYTHM, on ? this.regs[OPLL_R.RHYTHM] | RHYTHM.ENABLE : this.regs[OPLL_R.RHYTHM] & ~RHYTHM.ENABLE);
    }

    /** Triggers drums. Pass a mask of RHYTHM bits; retriggering needs an off write first. */
    triggerRhythm(mask: number): void {
        const base = this.regs[OPLL_R.RHYTHM] & RHYTHM.ENABLE;
        this.write(OPLL_R.RHYTHM, base);
        this.write(OPLL_R.RHYTHM, base | (mask & 0x1f));
    }

    /** Loads the 8 bytes of the user-definable instrument. */
    setCustomInstrument(parameters: ArrayLike<number>): void {
        for (let i = 0; i < 8 && i < parameters.length; ++i) this.write(OPLL_R.CUSTOM + i, parameters[i]);
    }

    silence(): void {
        for (let ch = 0; ch < 9; ++ch) {
            this.setKeyOn(ch as OpllChannel, false);
            this.setVolume(ch as OpllChannel, 15);
        }
        this.write(OPLL_R.RHYTHM, 0);
    }

    reset(): void {
        this.regs.fill(0);
        this.chip.reset();
    }
}

/**
 * Converts a frequency to the chip's (F-number, block) pair.
 *
 * fnum = hz * 2^19 / (sampleRate * 2^block), and the F-number is 9 bits, so we
 * take the lowest block that keeps it in range - that is the one with the most
 * precision left.
 */
export function pitchToFrequency(hz: number): { fnum: number; block: number } {
    for (let block = 0; block < 7; ++block) {
        const fnum = Math.round((hz * (1 << 19)) / (SAMPLE_RATE * (1 << block)));
        if (fnum < 512) return { fnum, block };
    }
    return { fnum: 511, block: 7 };
}
