import { describe, expect, it } from "vitest";
import { createSystem, ENVELOPE, INSTRUMENT } from "../src/index.js";
import { AudioMixer } from "../src/host/audio.js";

const RATE = 48000;

/** Captures `frames` of audio from a freshly built machine. */
function capture(setup: (system: ReturnType<typeof createSystem>) => void, frames: number): Float32Array {
    const system = createSystem();
    const mixer = new AudioMixer(system.machine, RATE);
    setup(system);

    const chunk = new Float32Array(Math.round(RATE / 60));
    const all = new Float32Array(chunk.length * frames);
    for (let i = 0; i < frames; ++i) {
        system.machine.frame();
        mixer.render(chunk);
        all.set(chunk, i * chunk.length);
    }
    return all;
}

/** Frequency by counting rising crossings of the mean - reliable for square waves. */
function crossingRate(samples: Float32Array): number {
    let mean = 0;
    for (const value of samples) mean += value;
    mean /= samples.length;

    let crossings = 0;
    for (let i = 1; i < samples.length; ++i) if (samples[i - 1] <= mean && samples[i] > mean) ++crossings;
    return crossings / (samples.length / RATE);
}

function rms(samples: Float32Array, from = 0): number {
    let sum = 0;
    for (let i = from; i < samples.length; ++i) sum += samples[i] * samples[i];
    return Math.sqrt(sum / (samples.length - from));
}

describe("AudioMixer", () => {
    it("resamples the PSG to the output rate without shifting its pitch", () => {
        for (const hz of [220, 440, 880]) {
            const audio = capture(({ psg }) => {
                psg.setTone(0, hz);
                psg.setVolume(0, 15);
                psg.setMixer([true, false, false]);
            }, 30);
            expect(crossingRate(audio)).toBeCloseTo(hz, -1);
        }
    });

    it("produces one frame of samples per frame of machine time", () => {
        const system = createSystem();
        const mixer = new AudioMixer(system.machine, RATE);
        expect(mixer.samplesPerFrame).toBe(800);

        const chunk = new Float32Array(800);
        system.machine.frame();
        mixer.render(chunk);
        expect(chunk.length).toBe(800);
    });

    it("stays silent when nothing is playing", () => {
        const audio = capture(() => {}, 10);
        expect(rms(audio)).toBeLessThan(0.001);
    });

    it("removes the DC a muted PSG channel leaves behind", () => {
        // Mixer off with a volume set is how the chip was made to play samples:
        // the channel sits at a steady level rather than at zero.
        const audio = capture(({ psg }) => {
            psg.setVolume(0, 15);
            psg.setMixer([false, false, false]);
        }, 30);

        const settled = audio.subarray(audio.length / 2);
        let mean = 0;
        for (const value of settled) mean += value;
        expect(Math.abs(mean / settled.length)).toBeLessThan(0.005);
        expect(rms(settled)).toBeLessThan(0.01);
    });

    it("mixes both chips into one stream", () => {
        // Measure past the attack, where both chips are at a steady level.
        const settled = 20 * 800 / 2;

        const psgOnly = rms(capture(({ psg }) => {
            psg.setTone(0, 440); psg.setVolume(0, 15); psg.setMixer([true, false, false]);
        }, 20), settled);

        const both = rms(capture(({ psg, opll }) => {
            psg.setTone(0, 440); psg.setVolume(0, 15); psg.setMixer([true, false, false]);
            opll.play(0, 220, INSTRUMENT.ORGAN, 0);
        }, 20), settled);

        const opllOnly = rms(capture(({ opll }) => {
            opll.play(0, 220, INSTRUMENT.ORGAN, 0);
        }, 20), settled);

        // Uncorrelated signals add as power, and one OPLL voice is scaled for
        // nine of them, so the sum is only a little above the louder chip.
        expect(opllOnly).toBeGreaterThan(0.005);
        expect(both).toBeGreaterThan(psgOnly);
        expect(both).toBeGreaterThan(opllOnly);
        expect(both).toBeCloseTo(Math.hypot(psgOnly, opllOnly), 1);
    });

    it("only connects the OPLL once something writes to it", () => {
        const system = createSystem();
        expect(system.machine.getAudioSignals()).toHaveLength(1);   // the PSG, from power on
        system.opll.play(0, 440, INSTRUMENT.PIANO, 0);
        expect(system.machine.getAudioSignals()).toHaveLength(2);
    });

    it("follows the PSG envelope generator down to silence", () => {
        const audio = capture(({ psg }) => {
            psg.setTone(0, 220);
            psg.setMixer([true, false, false]);
            psg.setVolume(0, 0, true);
            psg.setEnvelope(0x1000, ENVELOPE.DECAY);
        }, 40);

        const early = rms(audio.subarray(0, 8000));
        const late = rms(audio.subarray(audio.length - 8000));
        expect(early).toBeGreaterThan(0.02);
        expect(late).toBeLessThan(early / 4);
    });

    it("scales with the master volume", () => {
        const system = createSystem();
        const mixer = new AudioMixer(system.machine, RATE);
        system.psg.setTone(0, 440);
        system.psg.setVolume(0, 15);
        system.psg.setMixer([true, false, false]);

        const chunk = new Float32Array(800);
        for (let i = 0; i < 10; ++i) { system.machine.frame(); mixer.render(chunk); }
        const unity = rms(chunk);

        mixer.volume = 2;
        for (let i = 0; i < 10; ++i) { system.machine.frame(); mixer.render(chunk); }
        expect(rms(chunk)).toBeCloseTo(unity * 2, 1);
    });
});
