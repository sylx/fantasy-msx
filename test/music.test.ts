import { describe, expect, it } from "vitest";
import {
    compile, compileTrack, createBios, MMLError, opllVoice, psgVoice, rhythmVoice, semitoneToHz
} from "../src/bios/index.js";
import { OPLL_R, PSG_R, TONE_CLOCK } from "../src/index.js";

/** Frames of every timed event in a track, for checking rhythm. */
function durations(mml: string, voice = psgVoice(0)): number[] {
    return compileTrack(voice, mml).events
        .filter((event) => "frames" in event)
        .map((event) => (event as { frames: number }).frames);
}

function semitones(mml: string): number[] {
    return compileTrack(psgVoice(0), mml).events
        .filter((event) => event.type === "note")
        .map((event) => (event as { semitone: number }).semitone);
}

describe("MML notes", () => {
    it("maps the letters onto semitones", () => {
        expect(semitones("o4 cdefgab")).toEqual([48, 50, 52, 53, 55, 57, 59]);
    });

    it("takes sharps and flats", () => {
        expect(semitones("o4 c+ c# d- e+")).toEqual([49, 49, 49, 53]);
    });

    it("puts A above middle C at 440 Hz", () => {
        expect(semitoneToHz(semitones("o4 a")[0])).toBeCloseTo(440, 5);
        expect(semitoneToHz(semitones("o4 c")[0])).toBeCloseTo(261.63, 1);
    });

    it("moves octaves absolutely and by steps", () => {
        expect(semitones("o4 c > c > c < < c")).toEqual([48, 60, 72, 48]);
        expect(semitones("o2 a o6 a")).toEqual([33, 81]);
    });

    it("reads a note by number", () => {
        expect(semitones("n60 n61")).toEqual([60, 61]);
    });
});

describe("MML timing", () => {
    it("turns tempo and length into frames", () => {
        // At 120 a quarter note is half a second: thirty frames.
        expect(durations("t120 l4 c")).toEqual([30]);
        expect(durations("t120 l8 c")).toEqual([15]);
        expect(durations("t60 l4 c")).toEqual([60]);
    });

    it("adds half again for each dot", () => {
        expect(durations("t120 c4.")).toEqual([45]);
        expect(durations("t120 c4..")).toEqual([53]);   // 30 + 15 + 7.5, rounded
    });

    it("keeps tracks the same length whatever they are divided into", () => {
        // An eighth at 150 is 12.8 frames; rounding each one alone would drift.
        const bar = 96;
        expect(compileTrack(psgVoice(0), "t150 l8 cdefgabc").frames).toBe(bar);
        expect(compileTrack(psgVoice(0), "t150 l4 cdef").frames).toBe(bar);
        expect(compileTrack(psgVoice(0), "t150 l2 cd").frames).toBe(bar);
        expect(compileTrack(psgVoice(0), "t150 l1 c").frames).toBe(bar);
        expect(compileTrack(psgVoice(0), "t150 l4 c.d.r8r8").frames).toBe(bar);
    });

    it("joins tied notes into one", () => {
        expect(durations("t120 l4 c & c")).toEqual([60]);
        expect(semitones("t120 l4 c & c")).toEqual([48]);
    });

    it("counts rests as time", () => {
        expect(durations("t120 l4 c r c")).toEqual([30, 30, 30]);
    });
});

describe("MML structure", () => {
    it("repeats a bracketed body", () => {
        expect(semitones("[cde]3")).toEqual([48, 50, 52, 48, 50, 52, 48, 50, 52]);
        expect(semitones("[cd]")).toEqual([48, 50, 48, 50]);     // twice by default
    });

    it("nests repeats", () => {
        expect(semitones("[[cd]2 e]2")).toEqual([48, 50, 48, 50, 52, 48, 50, 48, 50, 52]);
    });

    it("keeps a repeated body's timing", () => {
        // Two bars of sixteenths, played twice: four bars of 96 frames each.
        expect(compileTrack(psgVoice(0), "t150 l16 [[acea]4 [facf]4]2").frames).toBe(4 * 96);
    });

    it("compiles several voices at once", () => {
        const song = compile([
            { voice: psgVoice(0), mml: "t120 l4 cde" },
            { voice: opllVoice(3), mml: "t120 l4 @5 c" }
        ]);
        expect(song.tracks).toHaveLength(2);
        expect(song.tracks[1].voice).toEqual({ chip: "opll", channel: 3 });
    });
});

describe("MML rhythm tracks", () => {
    it("spells drums as letters", () => {
        const events = compileTrack(rhythmVoice(), "l8 c d e f g").events;
        expect(events.map((e) => (e as { mask: number }).mask)).toEqual([0x10, 0x08, 0x04, 0x02, 0x01]);
    });

    it("strikes braced drums together", () => {
        const events = compileTrack(rhythmVoice(), "l8 {cg} {dg}").events;
        expect(events.map((e) => (e as { mask: number }).mask)).toEqual([0x11, 0x09]);
    });

    it("reads unbraced letters as separate hits", () => {
        // "cg" without braces has to mean a kick then a hi-hat, or the notation
        // could not express two drums in a row at all.
        expect(compileTrack(rhythmVoice(), "l8 cg").events).toHaveLength(2);
    });
});

describe("MML errors", () => {
    it("points at what it could not read", () => {
        expect(() => compileTrack(psgVoice(0), "cde ?")).toThrow(MMLError);
        expect(() => compileTrack(psgVoice(0), "[cde")).toThrow(/without a matching/);
        expect(() => compileTrack(psgVoice(0), "cde]")).toThrow(/without a matching/);
        expect(() => compileTrack(psgVoice(0), "t20 c")).toThrow(/tempo/);
        expect(() => compileTrack(psgVoice(0), "v99 c")).toThrow(/volume/);
        expect(() => compileTrack(psgVoice(0), "o9 c")).toThrow(/octave/);
    });

    it("says where in the string the trouble is", () => {
        try {
            compileTrack(psgVoice(0), "cdefg ? ab");
            expect.unreachable();
        } catch (error) {
            expect((error as MMLError).position).toBe(7);
        }
    });
});

describe("SoundDriver", () => {
    it("writes the PSG registers a note at a time", () => {
        const { bgm, screen, system } = createBios();
        bgm.play(compile([{ voice: psgVoice(0), mml: "t120 l4 v12 q8 o4 a" }]));

        screen.frame();
        // A440 becomes a period of 112005/440, and the channel is unmuted.
        const period = system.psg.read(PSG_R.TONE_A_LOW) | (system.psg.read(PSG_R.TONE_A_HIGH) << 8);
        // Periods are whole numbers, so the pitch quantises - about three cents
        // out at A440, which is what the hardware does too.
        expect(Math.abs(1200 * Math.log2(TONE_CLOCK / period / 440))).toBeLessThan(5);
        expect(system.psg.read(PSG_R.VOLUME_A)).toBe(12);
        expect(system.psg.read(PSG_R.MIXER) & 0x01).toBe(0);        // tone A enabled
    });

    it("releases a note early when the gate is short", () => {
        const { bgm, screen, system } = createBios();
        bgm.play(compile([{ voice: psgVoice(0), mml: "t120 l4 v12 q4 o4 a" }]));

        screen.frame();
        expect(system.psg.read(PSG_R.VOLUME_A)).toBe(12);
        for (let i = 0; i < 15; ++i) screen.frame();                // half of thirty frames
        expect(system.psg.read(PSG_R.VOLUME_A)).toBe(0);
    });

    it("finishes, and stays finished, unless told to loop", () => {
        const { bgm, screen } = createBios();
        bgm.play(compile([{ voice: psgVoice(0), mml: "t120 l4 cd" }]));

        for (let i = 0; i < 59; ++i) screen.frame();
        expect(bgm.playing).toBe(true);
        for (let i = 0; i < 3; ++i) screen.frame();
        expect(bgm.playing).toBe(false);
    });

    it("goes round again when looping", () => {
        const { bgm, screen } = createBios();
        bgm.play(compile([{ voice: psgVoice(0), mml: "t120 l4 cd" }]), { loop: true });
        for (let i = 0; i < 200; ++i) screen.frame();
        expect(bgm.playing).toBe(true);
    });

    it("silences the chips when stopped", () => {
        const { bgm, screen, system } = createBios();
        bgm.play(compile([{ voice: psgVoice(0), mml: "t120 l1 v15 o4 a" }]));
        screen.frame();
        expect(system.psg.read(PSG_R.VOLUME_A)).toBe(15);

        bgm.stop();
        expect(bgm.playing).toBe(false);
        expect(system.psg.read(PSG_R.VOLUME_A)).toBe(0);
        expect(system.psg.read(PSG_R.MIXER)).toBe(0x3f);            // everything off
    });

    it("sets the OPLL instrument, pitch and key together", () => {
        const { bgm, screen, system } = createBios();
        bgm.play(compile([{ voice: opllVoice(2), mml: "t120 l4 @7 v15 o4 a" }]));
        screen.frame();

        expect(system.opll.read(OPLL_R.INSTRUMENT + 2) >> 4).toBe(7);
        expect(system.opll.read(OPLL_R.INSTRUMENT + 2) & 0x0f).toBe(0);   // loudest is zero
        expect(system.opll.read(OPLL_R.BLOCK + 2) & 0x10).toBe(0x10);     // key on
    });

    it("turns rhythm mode on for a drum track", () => {
        const { bgm, screen, system } = createBios();
        bgm.play(compile([{ voice: rhythmVoice(), mml: "t120 l4 {cg}" }]));
        screen.frame();
        expect(system.opll.read(OPLL_R.RHYTHM) & 0x20).toBe(0x20);
        expect(system.opll.read(OPLL_R.RHYTHM) & 0x11).toBe(0x11);
    });

    it("lends a voice to an effect and takes it back", () => {
        const { bgm, screen, system } = createBios();
        bgm.play(compile([{ voice: psgVoice(0), mml: "t120 l1 v15 o4 a" }]), { loop: true });
        screen.frame();
        const music = system.psg.read(PSG_R.TONE_A_LOW) | (system.psg.read(PSG_R.TONE_A_HIGH) << 8);

        bgm.effect(psgVoice(0), "t120 l16 v15 o7 c");
        screen.frame();
        const effect = system.psg.read(PSG_R.TONE_A_LOW) | (system.psg.read(PSG_R.TONE_A_HIGH) << 8);
        expect(effect).toBeLessThan(music);                 // a much higher note
        expect(bgm.effectsPlaying).toBe(true);

        for (let i = 0; i < 10; ++i) screen.frame();
        expect(bgm.effectsPlaying).toBe(false);
        expect(bgm.playing).toBe(true);                     // the music never stopped
    });
});
