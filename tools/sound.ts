// Puts both sound chips through their paces and writes a WAV, so the audio
// path can be checked by ear as well as by test.

import { writeFileSync } from "node:fs";
import { createSystem, ENVELOPE, INSTRUMENT, RHYTHM } from "../src/index.js";
import { AudioMixer } from "../src/host/audio.js";
import { encodeWAV } from "./wav.js";

const RATE = 48000;
const system = createSystem();
const mixer = new AudioMixer(system.machine, RATE);
const { psg, opll, machine } = system;

const perFrame = Math.round(RATE / 60);
const chunk = new Float32Array(perFrame);
const captured: Float32Array[] = [];

/** Runs the machine for `frames`, capturing what comes out. */
function play(frames: number): void {
    for (let i = 0; i < frames; ++i) {
        machine.frame();
        mixer.render(chunk);
        captured.push(chunk.slice());
    }
}

const NOTE = { C: 261.63, D: 293.66, E: 329.63, F: 349.23, G: 392.0, A: 440.0, B: 493.88 };

// 1. PSG: three square waves, one chord.
psg.setMixer([true, true, true]);
psg.setTone(0, NOTE.C);
psg.setTone(1, NOTE.E);
psg.setTone(2, NOTE.G);
psg.setVolume(0, 13); psg.setVolume(1, 11); psg.setVolume(2, 11);
play(40);

// 2. PSG: an arpeggio, the way a sound driver would write it - once a frame.
psg.setVolume(1, 0); psg.setVolume(2, 0);
const arpeggio = [NOTE.C, NOTE.E, NOTE.G, NOTE.C * 2, NOTE.G, NOTE.E];
for (let i = 0; i < 24; ++i) {
    psg.setTone(0, arpeggio[i % arpeggio.length]);
    play(5);
}

// 3. PSG: the envelope generator sweeping a note down.
psg.setTone(0, NOTE.A / 2);
psg.setVolume(0, 0, true);
psg.setEnvelope(0x2000, ENVELOPE.DECAY);
play(45);

// 4. PSG: noise, which is what percussion was made of.
psg.setVolume(0, 15);
psg.setMixer([false, false, false], [true, false, false]);
for (const period of [4, 8, 16, 2]) {
    psg.setNoisePeriod(period);
    play(12);
}
psg.setMixer([false, false, false]);
play(10);

// 5. OPLL: four of the built-in instruments, same phrase each.
const phrase = [NOTE.C, NOTE.E, NOTE.G, NOTE.B];
for (const instrument of [INSTRUMENT.PIANO, INSTRUMENT.FLUTE, INSTRUMENT.TRUMPET, INSTRUMENT.VIBRAPHONE]) {
    for (const hz of phrase) {
        opll.play(0, hz, instrument, 0);
        play(14);
    }
    opll.setKeyOn(0, false);
    play(6);
}

// 6. OPLL: six voices at once, then the rhythm section.
opll.setRhythmMode(false);
[NOTE.C / 2, NOTE.G / 2, NOTE.C, NOTE.E, NOTE.G, NOTE.B].forEach((hz, channel) => {
    opll.play(channel as 0, hz, INSTRUMENT.ORGAN, 2);
});
play(50);
for (let channel = 0; channel < 6; ++channel) opll.setKeyOn(channel as 0, false);
play(10);

opll.setRhythmMode(true);
opll.setVolume(6, 0); opll.setVolume(7, 0); opll.setVolume(8, 0);
for (const drum of [RHYTHM.BASS_DRUM, RHYTHM.SNARE_DRUM, RHYTHM.HI_HAT, RHYTHM.TOM_TOM, RHYTHM.CYMBAL,
                    RHYTHM.BASS_DRUM | RHYTHM.HI_HAT, RHYTHM.SNARE_DRUM | RHYTHM.HI_HAT]) {
    opll.triggerRhythm(drum);
    play(14);
}
play(30);

const total = captured.reduce((sum, c) => sum + c.length, 0);
const all = new Float32Array(total);
let at = 0;
for (const c of captured) { all.set(c, at); at += c.length; }

const out = process.argv[2] ?? "sound.wav";
writeFileSync(out, encodeWAV(all, RATE));
const peak = all.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
console.log(`${out}: ${(all.length / RATE).toFixed(2)}s, ${captured.length} frames, peak ${peak.toFixed(3)}`);
