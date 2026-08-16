// MML: the notation MSX BASIC's PLAY statement used, compiled to something a
// sound driver can step through a frame at a time.
//
//     "t120 l8 o4 v13 cdefgab>c"
//
// Lengths, octaves and tempo are resolved while compiling, so every note comes
// out carrying the number of frames it lasts. The driver then only has to
// count down.

/** Which chip and voice a track drives. */
export type Voice =
    | { readonly chip: "psg"; readonly channel: 0 | 1 | 2 }
    | { readonly chip: "opll"; readonly channel: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 }
    | { readonly chip: "rhythm" };

export const psgVoice = (channel: 0 | 1 | 2): Voice => ({ chip: "psg", channel });
export const opllVoice = (channel: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8): Voice => ({ chip: "opll", channel });
export const rhythmVoice = (): Voice => ({ chip: "rhythm" });

export type Event =
    /** `semitone` is absolute: 0 is C in octave 0, 48 is middle C. */
    | { readonly type: "note"; readonly semitone: number; readonly frames: number; readonly gate: number }
    | { readonly type: "rest"; readonly frames: number }
    | { readonly type: "volume"; readonly value: number }
    | { readonly type: "instrument"; readonly value: number }
    | { readonly type: "envelope"; readonly shape: number; readonly period: number }
    | { readonly type: "noise"; readonly period: number }
    /** Rhythm voices trigger a mask of drums rather than a pitch. */
    | { readonly type: "drum"; readonly mask: number; readonly frames: number };

export interface Track {
    readonly voice: Voice;
    readonly events: readonly Event[];
    /** Frames the track lasts, for lining tracks up and for looping. */
    readonly frames: number;
}

export interface Song {
    readonly tracks: readonly Track[];
}

export interface TrackSource {
    readonly voice: Voice;
    readonly mml: string;
}

/** Semitone offsets of the note letters within an octave. */
const LETTERS: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** Which drum each letter triggers on a rhythm track, matching the OPLL's bits. */
const DRUMS: Record<string, number> = {
    c: 0x10,    // bass drum
    d: 0x08,    // snare
    e: 0x04,    // tom tom
    f: 0x02,    // cymbal
    g: 0x01     // hi-hat
};

const FRAME_RATE = 60;
/** A quarter note at tempo T lasts 3600/T frames, so a whole note is four of those. */
const WHOLE_NOTE_FRAMES = FRAME_RATE * 60 * 4;

export class MMLError extends Error {
    constructor(message: string, readonly source: string, readonly position: number) {
        const line = source.slice(Math.max(0, position - 12), position + 12);
        super(`${message} at ${position}: ...${line}...`);
        this.name = "MMLError";
    }
}

class Reader {
    position = 0;

    constructor(readonly source: string) {}

    get done(): boolean {
        return this.position >= this.source.length;
    }

    /** Next character, lowercased, with whitespace already skipped. */
    peek(): string {
        while (this.position < this.source.length && /\s/.test(this.source[this.position])) ++this.position;
        return this.source[this.position]?.toLowerCase() ?? "";
    }

    take(): string {
        const character = this.peek();
        ++this.position;
        return character;
    }

    /** Reads a run of digits, or returns undefined when the next thing is not one. */
    number(): number | undefined {
        this.peek();
        let digits = "";
        while (/[0-9]/.test(this.source[this.position] ?? "")) digits += this.source[this.position++];
        return digits.length > 0 ? Number(digits) : undefined;
    }

    // A readonly property rather than a method: TypeScript only lets a
    // never-returning call narrow types when the callee is one of these.
    readonly fail = (message: string): never => {
        throw new MMLError(message, this.source, this.position);
    };
}

interface State {
    octave: number;
    defaultLength: number;
    tempo: number;
    gate: number;
}

/**
 * Compiles one MML string.
 *
 * Understood: `cdefgab` with `+`/`#`/`-`, `r` rests, `n` for a note by number,
 * `o` and `<` `>` for octave, `l` default length, `t` tempo, `v` volume,
 * `q` gate length in eighths, `@` instrument, `s`/`m` the PSG envelope,
 * `&` ties, and `[ ... ]n` repeats.
 *
 * Rhythm tracks spell drums as letters instead of pitches - c is the bass
 * drum, d the snare, e the tom, f the cymbal, g the hi-hat - and brace those
 * that land on the same beat: `{cg}8`.
 */
export function compileTrack(voice: Voice, mml: string): Track {
    const reader = new Reader(mml);
    const events: Event[] = [];
    const state: State = { octave: 4, defaultLength: 4, tempo: 120, gate: 8 };

    /** Stack of repeat brackets: where the body started in `events`. */
    const repeats: Array<{ start: number }> = [];

    // Note lengths rarely land on whole frames - an eighth at tempo 132 is
    // 13.64 of them - so rounding each one alone would let tracks made of
    // different lengths drift apart. Rounding the running total instead keeps
    // every track the same length as every other.
    let elapsedExact = 0;
    let elapsedFrames = 0;

    const quantise = (exact: number): number => {
        elapsedExact += exact;
        const frames = Math.max(1, Math.round(elapsedExact) - elapsedFrames);
        elapsedFrames += frames;
        return frames;
    };

    const lengthInFrames = (): number => {
        const denominator = reader.number() ?? state.defaultLength;
        if (denominator < 1 || denominator > 64) reader.fail(`note length ${denominator} is outside 1..64`);

        let exact = WHOLE_NOTE_FRAMES / (state.tempo * denominator);
        // Each dot adds half of what came before it.
        let extra = exact;
        while (reader.peek() === ".") {
            reader.take();
            extra /= 2;
            exact += extra;
        }
        return quantise(exact);
    };

    const pushNote = (semitone: number, frames: number): void => {
        const previous = events[events.length - 1];
        // A tie extends the note before it rather than starting a new one.
        if (tied && previous?.type === "note") {
            events[events.length - 1] = { ...previous, frames: previous.frames + frames, gate: 8 };
            tied = false;
            return;
        }
        tied = false;
        events.push({ type: "note", semitone, frames, gate: state.gate });
    };

    let tied = false;

    while (!reader.done) {
        const character = reader.take();
        if (character === "") break;

        if (character in LETTERS && voice.chip !== "rhythm") {
            let semitone = state.octave * 12 + LETTERS[character];
            for (;;) {
                const accidental = reader.peek();
                if (accidental === "+" || accidental === "#") { ++semitone; reader.take(); }
                else if (accidental === "-") { --semitone; reader.take(); }
                else break;
            }
            pushNote(semitone, lengthInFrames());
            continue;
        }

        if (voice.chip === "rhythm" && character in DRUMS) {
            events.push({ type: "drum", mask: DRUMS[character], frames: lengthInFrames() });
            continue;
        }

        // Drums struck together are braced: "{cg}8" is a kick and a hi-hat on
        // the same beat. Without the braces "cg" would be indistinguishable
        // from a kick followed by a hi-hat.
        if (voice.chip === "rhythm" && character === "{") {
            let mask = 0;
            for (;;) {
                const letter = reader.take();
                if (letter === "}") break;
                if (!(letter in DRUMS)) reader.fail(`"${letter}" is not a drum`);
                mask |= DRUMS[letter];
            }
            if (mask === 0) reader.fail("{} needs at least one drum");
            events.push({ type: "drum", mask, frames: lengthInFrames() });
            continue;
        }

        switch (character) {
            case "r":
            case "p":
                events.push({ type: "rest", frames: lengthInFrames() });
                tied = false;
                break;

            case "n": {
                const number = reader.number() ?? reader.fail("n needs a note number");
                pushNote(number, quantise(WHOLE_NOTE_FRAMES / (state.tempo * state.defaultLength)));
                break;
            }

            case "o": {
                const octave = reader.number() ?? reader.fail("o needs an octave 0..8");
                if (octave < 0 || octave > 8) reader.fail("o needs an octave 0..8");
                state.octave = octave;
                break;
            }

            case ">": ++state.octave; break;
            case "<": --state.octave; break;

            case "l": {
                const length = reader.number() ?? reader.fail("l needs a length");
                state.defaultLength = length;
                break;
            }

            case "t": {
                const tempo = reader.number() ?? reader.fail("t needs a tempo 32..255");
                if (tempo < 32 || tempo > 255) reader.fail("t needs a tempo 32..255");
                state.tempo = tempo;
                break;
            }

            case "v": {
                const volume = reader.number() ?? reader.fail("v needs a volume 0..15");
                if (volume > 15) reader.fail("v needs a volume 0..15");
                events.push({ type: "volume", value: volume });
                break;
            }

            case "q": {
                const gate = reader.number() ?? reader.fail("q needs a gate 1..8");
                if (gate < 1 || gate > 8) reader.fail("q needs a gate 1..8");
                state.gate = gate;
                break;
            }

            case "@": {
                const instrument = reader.number() ?? reader.fail("@ needs an instrument 0..15");
                if (instrument > 15) reader.fail("@ needs an instrument 0..15");
                events.push({ type: "instrument", value: instrument });
                break;
            }

            case "s": {
                const shape = reader.number() ?? reader.fail("s needs an envelope shape 0..15");
                if (shape > 15) reader.fail("s needs an envelope shape 0..15");
                events.push({ type: "envelope", shape, period: 0x1000 });
                break;
            }

            case "m": {
                const period = reader.number() ?? reader.fail("m needs an envelope period");
                const last = [...events].reverse().find((e) => e.type === "envelope");
                events.push({ type: "envelope", shape: last?.type === "envelope" ? last.shape : 0, period });
                break;
            }

            case "w": {
                const period = reader.number() ?? reader.fail("w needs a noise period 0..31");
                if (period > 31) reader.fail("w needs a noise period 0..31");
                events.push({ type: "noise", period });
                break;
            }

            case "&":
                tied = true;
                break;

            case "[":
                repeats.push({ start: events.length });
                break;

            case "]": {
                const repeat = repeats.pop() ?? reader.fail("] without a matching [");
                const times = reader.number() ?? 2;
                const body = events.slice(repeat.start);
                for (let i = 1; i < times; ++i) events.push(...body);

                // The copies carry the durations the body already settled on,
                // so tell the accumulator about the time they take up.
                let bodyFrames = 0;
                for (const event of body) {
                    if (event.type === "note" || event.type === "rest" || event.type === "drum") bodyFrames += event.frames;
                }
                elapsedFrames += bodyFrames * (times - 1);
                elapsedExact += bodyFrames * (times - 1);
                break;
            }

            default:
                reader.fail(`unexpected "${character}"`);
        }
    }

    if (repeats.length > 0) reader.fail("[ without a matching ]");

    let frames = 0;
    for (const event of events) {
        if (event.type === "note" || event.type === "rest" || event.type === "drum") frames += event.frames;
    }
    return { voice, events, frames };
}

/** Compiles a whole song - one MML string per voice. */
export function compile(sources: readonly TrackSource[]): Song {
    return { tracks: sources.map((source) => compileTrack(source.voice, source.mml)) };
}

/** Concert pitch of a semitone, with 57 - A in octave 4 - at 440 Hz. */
export function semitoneToHz(semitone: number): number {
    return 440 * Math.pow(2, (semitone - 57) / 12);
}
