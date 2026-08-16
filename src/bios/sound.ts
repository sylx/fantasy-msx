// The sound driver.
//
// It works the way an MSX music driver did: once per frame, on the vertical
// interrupt, it walks each track, counts a frame off the note in progress and
// writes whatever registers changed. Nothing is scheduled ahead; the chips only
// ever know about the frame they are in.
//
// That is also why tempo resolves to whole frames at compile time. A driver on
// a 60Hz interrupt cannot place a note anywhere else.

import type { Opll, Psg } from "../api/index.js";
import { compileTrack, semitoneToHz, type Event, type Song, type Track, type Voice } from "./mml.js";

/** Everything one track needs to know about where it is. */
interface TrackState {
    track: Track;
    cursor: number;
    /** Frames left on the note or rest in progress. */
    remaining: number;
    /** Frames until the note is released. Zero once it has been. */
    gate: number;
    volume: number;
    instrument: number;
    /** Set while the envelope generator owns this channel's level. */
    envelope: boolean;
    finished: boolean;
    loop: boolean;
}

function voiceKey(voice: Voice): string {
    return voice.chip === "rhythm" ? "rhythm" : `${voice.chip}:${voice.channel}`;
}

export class SoundDriver {
    private bgm: TrackState[] = [];
    private effects = new Map<string, TrackState>();

    /** PSG mixer bits, mirrored so a track can change its own without disturbing others. */
    private toneOn = [false, false, false];
    private noiseOn = [false, false, false];
    private rhythmEnabled = false;

    constructor(private readonly psg: Psg, private readonly opll: Opll) {}

    get playing(): boolean {
        return this.bgm.some((state) => !state.finished);
    }

    /** True while any one-shot effect is still sounding. */
    get effectsPlaying(): boolean {
        return this.effects.size > 0;
    }

    /** Starts a song, replacing whatever was playing. */
    play(song: Song, options: { loop?: boolean } = {}): void {
        this.stop();
        this.bgm = song.tracks.map((track) => this.newState(track, options.loop ?? false));
    }

    /**
     * Plays a one-shot on one voice, taking it away from the music until it
     * finishes. This is what an MSX game did for sound effects: there were no
     * spare channels, so the music simply lost one for a moment.
     */
    effect(voice: Voice, mml: string): void {
        const track = compileTrack(voice, mml);
        this.effects.set(voiceKey(voice), this.newState(track, false));
    }

    /** Silences everything and forgets where it was. */
    stop(): void {
        for (const state of this.bgm) this.release(state.track.voice);
        for (const state of this.effects.values()) this.release(state.track.voice);
        this.bgm = [];
        this.effects.clear();
        this.psg.silence();
        this.opll.silence();
        this.toneOn = [false, false, false];
        this.noiseOn = [false, false, false];
        this.updateMixer();
    }

    /** One frame. Call this on every vertical interrupt and nowhere else. */
    tick(): void {
        for (const [key, state] of this.effects) {
            this.advance(state);
            if (state.finished) {
                this.release(state.track.voice);
                this.effects.delete(key);
            }
        }

        for (const state of this.bgm) {
            // A voice an effect has taken over is left alone until it is back.
            if (this.effects.has(voiceKey(state.track.voice))) continue;
            this.advance(state);
        }
    }

    // --- Stepping ---------------------------------------------------------

    private newState(track: Track, loop: boolean): TrackState {
        return {
            track, cursor: 0, remaining: 0, gate: 0,
            volume: 15, instrument: 1, envelope: false, finished: false, loop
        };
    }

    private advance(state: TrackState): void {
        if (state.finished) return;

        // Everything with no duration - volume, instrument - happens at once,
        // so keep reading until something that takes time turns up.
        while (state.remaining === 0) {
            if (state.cursor >= state.track.events.length) {
                if (!state.loop || state.track.events.length === 0) {
                    state.finished = true;
                    this.release(state.track.voice);
                    return;
                }
                state.cursor = 0;
            }
            this.apply(state, state.track.events[state.cursor++]);
        }

        if (state.gate > 0 && --state.gate === 0) this.release(state.track.voice);
        --state.remaining;
    }

    private apply(state: TrackState, event: Event): void {
        const voice = state.track.voice;

        switch (event.type) {
            case "volume":
                state.volume = event.value;
                state.envelope = false;
                this.setVolume(voice, state.volume);
                break;

            case "instrument":
                state.instrument = event.value;
                break;

            case "envelope":
                if (voice.chip === "psg") {
                    state.envelope = true;
                    this.psg.setEnvelope(event.period, event.shape);
                }
                break;

            case "noise":
                if (voice.chip === "psg") {
                    this.psg.setNoisePeriod(event.period);
                    this.noiseOn[voice.channel] = event.period > 0;
                    this.updateMixer();
                }
                break;

            case "rest":
                this.release(voice);
                state.gate = 0;
                state.remaining = event.frames;
                break;

            case "note":
                this.keyOn(state, semitoneToHz(event.semitone));
                state.remaining = event.frames;
                state.gate = Math.max(1, Math.floor((event.frames * event.gate) / 8));
                break;

            case "drum":
                if (voice.chip === "rhythm") {
                    if (!this.rhythmEnabled) {
                        this.opll.setRhythmMode(true);
                        this.rhythmEnabled = true;
                    }
                    for (const channel of [6, 7, 8] as const) this.opll.setVolume(channel, 15 - state.volume);
                    this.opll.triggerRhythm(event.mask);
                }
                state.remaining = event.frames;
                state.gate = 0;
                break;
        }
    }

    // --- Registers --------------------------------------------------------

    private keyOn(state: TrackState, hz: number): void {
        const voice = state.track.voice;

        if (voice.chip === "psg") {
            this.psg.setTone(voice.channel, hz);
            this.toneOn[voice.channel] = true;
            this.updateMixer();
            this.psg.setVolume(voice.channel, state.envelope ? 0 : state.volume, state.envelope);
        } else if (voice.chip === "opll") {
            this.opll.setKeyOn(voice.channel, false);
            // The OPLL counts down from loudest, so an MML volume inverts.
            this.opll.setInstrument(voice.channel, state.instrument, 15 - state.volume);
            this.opll.setPitch(voice.channel, hz);
            this.opll.setKeyOn(voice.channel, true);
        }
    }

    private release(voice: Voice): void {
        if (voice.chip === "psg") {
            this.psg.setVolume(voice.channel, 0);
        } else if (voice.chip === "opll") {
            this.opll.setKeyOn(voice.channel, false);
        }
    }

    private setVolume(voice: Voice, volume: number): void {
        if (voice.chip === "psg") this.psg.setVolume(voice.channel, volume);
        else if (voice.chip === "opll") this.opll.setVolume(voice.channel, 15 - volume);
    }

    /** R7 is shared by every channel, so it is rebuilt from the driver's own mirror. */
    private updateMixer(): void {
        this.psg.setMixer(this.toneOn, this.noiseOn);
    }
}
