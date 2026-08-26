// LOOM - a machine that writes the music, and a desk to mix it on.
//
// Nothing here is a score. There is no MML in this file and no `bgm.play`:
// the chords are drawn from a Markov chain over scale degrees, the melody is a
// motif walked across them, and both are handed to the chips a step at a time
// by a sequencer that runs on the vertical interrupt - which is where an MSX
// music driver ran, and the only clock this machine has.
//
// Two chips, seven parts, twelve voices, and every part audible as a thing
// of its own:
//
//   PAD    OPLL 0-3   the chord, voice-led so the parts move as little as they can
//   LEAD   OPLL 4     a generated phrase over the top
//   BASS   OPLL 5     roots, fifths and an approach note into the next chord
//   DRUM   OPLL 6-8   rhythm mode, which trades the last three FM voices for five drums
//   ARP    PSG A      the chord again, one note at a time, in sixteenths
//   ECHO   PSG B      the lead, three steps late and quieter: a delay line made of notes
//   HAT    PSG C      the noise generator, because that is what percussion was made of
//
// The desk along the bottom is worked with the mouse. Each part has a level, a
// voice and a mute, and they are the chips' own controls rather than a mixer
// laid over the top: an OPLL level is a four-bit attenuation written into the
// same register as the instrument number, and a PSG level is four bits that the
// driver rewrites every frame, which is how a chip with no envelope of its own
// worth using got plucks and swells.
//
// The picture is the composition itself. The lane across the top is the eight
// bars of harmony, the roll under it is every note of the phrase laid out at
// once, and the playhead sweeps through both. Regenerate and you watch the
// music change before you hear it.

import {
    BUTTON, INSTRUMENT, MOUSE, OPLL_R, RHYTHM, semitoneToHz,
    type App, type Channel, type Context, type OpllChannel
} from "../../src/index.js";

// --- The screen --------------------------------------------------------------

const WIDTH = 256;
const HEIGHT = 212;

/** Palette entries, by what they are for rather than by number. */
const C = {
    BACK: 0, PANEL: 1, EDGE: 2, GRID: 3,
    DIM: 4, TEXT: 5, BRIGHT: 6, ACCENT: 7,
    PAD: 8, LEAD: 9, BASS: 10, ARP: 11, ECHO: 12, HAT: 13, DRUM: 14, MUTED: 15
} as const;

/** Sixteen colours out of 512, three bits a channel. */
const PALETTE: ReadonlyArray<readonly [number, number, number]> = [
    [0, 0, 1],  // BACK    the paper everything sits on
    [1, 1, 2],  // PANEL   a panel face
    [2, 2, 3],  // EDGE    its border
    [3, 3, 4],  // GRID    beat lines, empty fader cells
    [4, 4, 5],  // DIM     text that is not the point
    [6, 6, 6],  // TEXT
    [7, 7, 7],  // BRIGHT
    [7, 5, 1],  // ACCENT  the playhead, and whatever is happening now
    [2, 4, 7],  // PAD
    [7, 6, 2],  // LEAD
    [2, 6, 3],  // BASS
    [6, 3, 7],  // ARP
    [4, 2, 6],  // ECHO
    [5, 5, 4],  // HAT
    [7, 4, 3],  // DRUM
    [6, 1, 1]   // MUTED
];

const CHAR = 6;
const LINE = 8;

/** The header, and the two buttons in it. */
const HEADER_H = 10;
const AUTO_X = 142;
const AUTO_W = 80;
const NEW_X = 226;
const NEW_W = 26;

/** The chord lane: one cell per bar. */
const LANE_Y = 12;
const LANE_H = 24;
const CELL_W = 31;
const CELL_X = 4;

/** The piano roll: the whole phrase at once, drums along the bottom. */
const ROLL_X = 4;
const ROLL_Y = 39;
const ROLL_W = 248;
const ROLL_H = 92;
/** Lines of the roll given to the note field; the rest is the drum lane. */
const NOTE_H = 78;
const DRUM_LANE = ROLL_Y + NOTE_H + 2;

/** The desk. */
const MIXER_Y = 134;
const ROW_H = 11;
const LED_X = 4;
const LED_W = 11;
const NAME_X = 18;
const VOICE_X = 46;
const VOICE_W = 50;
const FADER_X = 100;
const FADER_CELL = 8;
const LEVEL_X = 232;

// --- Time --------------------------------------------------------------------

const BARS = 8;
const STEPS_PER_BAR = 16;
const STEPS = BARS * STEPS_PER_BAR;

/**
 * Frames in one sixteenth note. A quarter note at 120 lasts 30 frames, so a
 * sixteenth lasts 7.5 of them - and the driver has nowhere to put the half. As
 * in the MML compiler, the running total is what gets rounded rather than each
 * step, so the phrase keeps its tempo even though no single step can.
 */
const framesPerStep = (bpm: number): number => 900 / bpm;

const TEMPOS = [96, 104, 112, 120, 132, 144] as const;

// --- Theory ------------------------------------------------------------------

interface Mode {
    readonly name: string;
    /** Semitones above the tonic, one per scale degree. */
    readonly steps: readonly number[];
    /** Whether this mode's keys read better with flats than with sharps. */
    readonly flats: boolean;
}

const MODES: readonly Mode[] = [
    { name: "IONIAN", steps: [0, 2, 4, 5, 7, 9, 11], flats: false },
    { name: "DORIAN", steps: [0, 2, 3, 5, 7, 9, 10], flats: true },
    { name: "PHRYGIAN", steps: [0, 1, 3, 5, 7, 8, 10], flats: true },
    { name: "LYDIAN", steps: [0, 2, 4, 6, 7, 9, 11], flats: false },
    { name: "MIXOLYD", steps: [0, 2, 4, 5, 7, 9, 10], flats: false },
    { name: "AEOLIAN", steps: [0, 2, 3, 5, 7, 8, 10], flats: true }
];

const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
/** Tonics nobody spells with sharps: G# major is Ab major, and reads like it. */
const FLAT_KEYS = new Set([1, 3, 5, 6, 8, 10]);

function noteNames(key: number, mode: Mode): readonly string[] {
    return mode.flats || FLAT_KEYS.has(key) ? FLAT_NAMES : SHARP_NAMES;
}
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII"];

/**
 * How often one degree follows another. Rows are the chord you are on, columns
 * the one you might go to - which is functional harmony written down as a table
 * rather than as a rule: the dominant nearly always goes home, the mediant
 * hardly ever goes anywhere, and nothing repeats itself.
 */
const AFTER: ReadonlyArray<readonly number[]> = [
    //  I  ii iii IV  V  vi vii
    [0, 3, 1, 4, 4, 3, 1],      // I
    [1, 0, 1, 1, 5, 1, 2],      // ii
    [1, 2, 0, 3, 1, 3, 0],      // iii
    [3, 2, 1, 0, 4, 1, 1],      // IV
    [6, 1, 1, 1, 0, 3, 0],      // V
    [2, 3, 1, 3, 2, 0, 1],      // vi
    [4, 0, 1, 0, 2, 1, 0]       // vii
];

/** How likely each degree is to be a seventh chord rather than a triad. */
const SEVENTHS = [0.3, 0.4, 0.2, 0.3, 0.6, 0.3, 0.1];

/**
 * Semitones above the tonic for scale degree `degree`, which may be any
 * integer: seven of them is an octave, so the arithmetic below can transpose a
 * chord tone by octaves without leaving the scale.
 */
function scaleStep(mode: Mode, degree: number): number {
    const octave = Math.floor(degree / 7);
    return octave * 12 + mode.steps[degree - octave * 7];
}

/** The absolute semitone of a scale degree, with degree 0 the tonic in octave 4. */
function pitchOf(key: number, mode: Mode, degree: number): number {
    return 48 + key + scaleStep(mode, degree);
}

interface Chord {
    readonly degree: number;
    /** Scale degrees of its tones, root first, relative to the key. */
    readonly tones: readonly number[];
    readonly name: string;
    readonly numeral: string;
}

/**
 * Stacks thirds on a scale degree, which is all a diatonic chord is: take every
 * other degree and the qualities look after themselves - the second degree
 * comes out minor in a major key and major in dorian without anything here
 * having to know that.
 */
function chordOn(key: number, mode: Mode, degree: number, seventh: boolean): Chord {
    const root = scaleStep(mode, degree);
    const third = scaleStep(mode, degree + 2) - root;
    const fifth = scaleStep(mode, degree + 4) - root;
    const top = scaleStep(mode, degree + 6) - root;

    const diminished = fifth === 6;
    const minor = third === 3;
    // A diminished chord with a seventh on it wants a name this lane has no
    // room for, so those stay triads.
    const extended = seventh && !diminished;

    const tones = [degree, degree + 2, degree + 4];
    if (extended) tones.push(degree + 6);

    const quality = diminished ? "o" : fifth === 8 ? "+" : minor ? "m" : "";
    const seventhName = !extended ? "" : top === 11 ? "M7" : "7";
    const letter = noteNames(key, mode)[(key + root + 120) % 12];

    return {
        degree,
        tones,
        name: letter + quality + seventhName,
        numeral: minor || diminished ? ROMAN[degree].toLowerCase() + (diminished ? "o" : "") : ROMAN[degree]
    };
}

/** True when scale degree `degree` is one of the chord's own notes. */
function isChordTone(chord: Chord, degree: number): boolean {
    const within = (((degree - chord.degree) % 7) + 7) % 7;
    return chord.tones.some((tone) => (((tone - chord.degree) % 7) + 7) % 7 === within);
}

/** The chord tone nearest `degree`, which is how a melody lands on a beat. */
function nearestChordTone(chord: Chord, degree: number): number {
    for (let distance = 0; distance < 4; ++distance) {
        if (isChordTone(chord, degree - distance)) return degree - distance;
        if (isChordTone(chord, degree + distance)) return degree + distance;
    }
    return degree;
}

/**
 * Moves a scale degree by octaves until it sits near a target. Seven degrees
 * are an octave, so this changes which octave a chord tone is sung in without
 * changing the note - which is the whole of voice leading.
 */
function nearOctave(degree: number, target: number): number {
    let moved = degree;
    while (moved < target - 3) moved += 7;
    while (moved > target + 3) moved -= 7;
    return moved;
}

const clamp = (value: number, low: number, high: number): number =>
    value < low ? low : value > high ? high : value;

// --- Chance ------------------------------------------------------------------

/**
 * xorshift32, seeded per phrase. A generator that can be re-run matters here:
 * changing the groove on the desk re-rolls the drums alone, and the rest of the
 * phrase has to come back exactly as it was.
 */
class Random {
    private state: number;

    constructor(seed: number) {
        this.state = (seed >>> 0) || 1;
    }

    next(): number {
        let x = this.state;
        x ^= x << 13; x >>>= 0;
        x ^= x >>> 17;
        x ^= x << 5; x >>>= 0;
        this.state = x;
        return x / 0x100000000;
    }

    int(bound: number): number {
        return Math.min(bound - 1, Math.floor(this.next() * bound));
    }

    pick<T>(items: readonly T[]): T {
        return items[this.int(items.length)];
    }

    chance(probability: number): boolean {
        return this.next() < probability;
    }

    /** An index into a table of weights, drawn in proportion to them. */
    weighted(weights: readonly number[]): number {
        let total = 0;
        for (const weight of weights) total += weight;
        let roll = this.next() * total;
        for (let i = 0; i < weights.length; ++i) {
            roll -= weights[i];
            if (roll < 0) return i;
        }
        return weights.length - 1;
    }
}

// --- What a phrase is --------------------------------------------------------

/** The parts that play notes. Drums and hats are patterns, not pitches. */
type Melodic = "pad" | "lead" | "bass" | "arp" | "echo";
type PartId = Melodic | "drum" | "hat";

const MELODIC: readonly Melodic[] = ["pad", "lead", "bass", "arp", "echo"];

interface Note {
    readonly step: number;
    /** In steps. What the driver turns into a gate is a fraction of it. */
    readonly length: number;
    readonly pitch: number;
    readonly accent: boolean;
}

interface Phrase {
    readonly seed: number;
    readonly key: number;
    readonly mode: Mode;
    readonly bpm: number;
    readonly chords: readonly Chord[];
    readonly notes: Record<Melodic, readonly Note[]>;
    /** OPLL rhythm bits, one entry per step. */
    readonly drums: Uint8Array;
    /** PSG hi-hat: 0 silent, 1 soft, 2 accented. */
    readonly hats: Uint8Array;
}

/** Registers each part sings in, as scale degrees above the tonic in octave 4. */
const LEAD_LOW = 2;
const LEAD_HIGH = 13;
/** The arpeggio holds itself around this degree, whatever the chord's shape. */
const ARP_CENTRE = 8;
const BASS_DOWN = 14;

/** How far behind the lead the echo runs. */
const ECHO_DELAY = 3;

// --- Harmony -----------------------------------------------------------------

/**
 * Eight bars of chords.
 *
 * The chain is left to wander for seven of them and then told where to finish:
 * the last bar is a dominant or a subdominant, so the loop leans back towards
 * the tonic it started on instead of stopping.
 */
function makeChords(random: Random, key: number, mode: Mode): Chord[] {
    const degrees = [0];
    for (let bar = 1; bar < BARS; ++bar) {
        let next = random.weighted(AFTER[degrees[bar - 1]]);
        // One redraw is enough to make a repeat rare without making it impossible.
        if (next === degrees[bar - 1]) next = random.weighted(AFTER[degrees[bar - 1]]);
        degrees.push(next);
    }
    degrees[BARS - 1] = random.chance(0.6) ? 4 : 3;

    return degrees.map((degree) => chordOn(key, mode, degree, random.chance(SEVENTHS[degree])));
}

/**
 * The chord itself, one voice per tone, held for the bar.
 *
 * Each voice moves to the nearest octave of its new note rather than to the
 * note as written, so the parts creep about by a semitone or two where a
 * literal reading would have them all leap together. The chip does not care;
 * the ear does.
 */
function makePad(chords: readonly Chord[]): Note[] {
    const notes: Note[] = [];
    let previous = [0, 2, 4, 6];

    chords.forEach((chord, bar) => {
        const voices = chord.tones.map((tone, i) => nearOctave(tone, previous[i] ?? previous[previous.length - 1]));
        previous = voices;
        for (const degree of voices) {
            notes.push({ step: bar * STEPS_PER_BAR, length: STEPS_PER_BAR, pitch: degree, accent: false });
        }
    });
    return notes;
}

/** Where the bass puts its notes, and which note of the chord each one is. */
type BassTone = "root" | "fifth" | "octave" | "approach";
const BASS_PATTERNS: ReadonlyArray<ReadonlyArray<readonly [number, number, BassTone]>> = [
    [[0, 8, "root"], [8, 8, "root"]],
    [[0, 4, "root"], [4, 4, "fifth"], [8, 4, "root"], [12, 4, "octave"]],
    [[0, 6, "root"], [6, 2, "octave"], [8, 4, "root"], [12, 4, "approach"]],
    [[0, 3, "root"], [3, 3, "root"], [7, 3, "fifth"], [10, 2, "root"], [14, 2, "approach"]],
    [[0, 4, "root"], [6, 2, "root"], [8, 4, "fifth"], [14, 2, "approach"]]
];

function makeBass(random: Random, chords: readonly Chord[]): Note[] {
    const pattern = random.pick(BASS_PATTERNS);
    const notes: Note[] = [];

    chords.forEach((chord, bar) => {
        const next = chords[(bar + 1) % BARS];
        for (const [step, length, tone] of pattern) {
            const degree =
                tone === "root" ? chord.degree - BASS_DOWN
                : tone === "fifth" ? chord.tones[2] - BASS_DOWN
                : tone === "octave" ? chord.degree - BASS_DOWN + 7
                // A step below the chord that is coming, which is what makes a
                // bass line sound like it knew where it was going.
                : next.degree - BASS_DOWN - 1;
            notes.push({
                step: bar * STEPS_PER_BAR + step,
                length,
                pitch: degree,
                accent: step === 0
            });
        }
    });
    return notes;
}

/** Sixteen steps of a bar, as [step, length] pairs. */
const LEAD_RHYTHMS: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
    [[0, 4], [4, 2], [6, 2], [8, 4], [12, 4]],
    [[0, 3], [3, 1], [4, 4], [8, 2], [10, 2], [12, 4]],
    [[2, 2], [4, 2], [6, 2], [8, 4], [14, 2]],
    [[0, 6], [6, 2], [8, 6], [14, 2]],
    [[0, 2], [2, 2], [4, 2], [6, 2], [8, 4], [12, 2], [14, 2]],
    [[0, 8], [8, 4], [12, 4]],
    [[4, 4], [8, 2], [10, 2], [12, 4]],
    [[0, 4], [7, 1], [8, 3], [11, 1], [12, 4]]
];

/**
 * The tune.
 *
 * Bars are laid out AABC AABD, so the ear hears the first bar again before it
 * has finished being surprised by it, and the shape of the phrase comes from
 * the arrangement rather than from anything clever happening inside a bar.
 *
 * Within a bar it is the oldest rule there is: land on a chord tone where the
 * beat is strong, walk by step where it is not, and leap occasionally to keep
 * the line from turning into a scale.
 */
function makeLead(random: Random, chords: readonly Chord[]): Note[] {
    const a = random.int(LEAD_RHYTHMS.length);
    const b = random.int(LEAD_RHYTHMS.length);
    const c = random.int(LEAD_RHYTHMS.length);
    const d = random.int(LEAD_RHYTHMS.length);
    const form = [a, a, b, c, a, a, b, d];
    // One bar in four or so is left to breathe.
    const rest = random.chance(0.5) ? 3 : random.chance(0.5) ? 7 : -1;

    const notes: Note[] = [];
    let degree = nearestChordTone(chords[0], LEAD_LOW + 6);

    form.forEach((rhythm, bar) => {
        if (bar === rest) return;
        const chord = chords[bar];

        for (const [step, length] of LEAD_RHYTHMS[rhythm]) {
            const strong = step % 4 === 0;
            if (strong) {
                if (random.chance(0.25)) degree += random.pick([-4, -3, 3, 4]);
                degree = nearestChordTone(chord, degree);
            } else {
                degree += random.pick([-2, -1, -1, 1, 1, 2]);
            }
            degree = clamp(degree, LEAD_LOW, LEAD_HIGH);
            notes.push({ step: bar * STEPS_PER_BAR + step, length, pitch: degree, accent: strong });
        }
    });
    return notes;
}

/** Which chord tone the arpeggio takes next, as an index into the chord. */
const ARP_SHAPES: ReadonlyArray<readonly number[]> = [
    [0, 1, 2, 3],           // up
    [0, 1, 2, 1],           // up and back
    [0, 2, 1, 3],           // spread
    [3, 2, 1, 0],           // down
    [0, 1, 2, 3, 2, 1]      // up and down, over six steps against a four-step bar
];

/**
 * The chord again, one note at a time, above the pad. Where the PSG is at its
 * best: a bare square wave moving fast enough that the ear hears the chord
 * rather than the notes.
 *
 * Every tone is folded into the octave around one degree, so a seventh chord
 * high up the scale does not send the figure a register above a triad's.
 */
function makeArp(random: Random, chords: readonly Chord[]): Note[] {
    const shape = random.pick(ARP_SHAPES);
    const rate = random.chance(0.65) ? 1 : 2;       // sixteenths or eighths
    const notes: Note[] = [];
    let index = 0;

    chords.forEach((chord, bar) => {
        for (let step = 0; step < STEPS_PER_BAR; step += rate) {
            // A gap on the last sixteenth of a bar, so the figure breathes.
            if (step === STEPS_PER_BAR - rate && random.chance(0.5)) continue;
            const tone = chord.tones[shape[index++ % shape.length] % chord.tones.length];
            notes.push({
                step: bar * STEPS_PER_BAR + step,
                length: rate,
                pitch: nearOctave(tone, ARP_CENTRE),
                accent: step % 4 === 0
            });
        }
    });
    return notes;
}

/**
 * The lead again, three steps behind and shorter. A delay line the driver never
 * hears about: by the time these reach the chips they are notes like any other,
 * which is how a machine with no effects unit got an echo.
 */
function makeEcho(lead: readonly Note[]): Note[] {
    return lead.map((note) => ({
        step: (note.step + ECHO_DELAY) % STEPS,
        length: Math.min(2, note.length),
        pitch: note.pitch,
        accent: false
    }));
}

// --- Percussion --------------------------------------------------------------

const BD = RHYTHM.BASS_DRUM;
const SD = RHYTHM.SNARE_DRUM;
const TM = RHYTHM.TOM_TOM;
const CY = RHYTHM.CYMBAL;

interface Groove {
    readonly name: string;
    /** One bar of rhythm bits, and the bar that ends the phrase. */
    readonly bar: readonly number[];
    readonly fill: readonly number[];
}

const GROOVES: readonly Groove[] = [
    {
        name: "STRGHT",
        bar: [BD, 0, 0, 0, SD, 0, 0, 0, BD, 0, BD, 0, SD, 0, 0, 0],
        fill: [BD, 0, 0, 0, SD, 0, SD, 0, TM, 0, TM, 0, SD, 0, SD, CY]
    },
    {
        name: "SHUFFL",
        bar: [BD, 0, 0, BD, SD, 0, 0, 0, 0, 0, BD, 0, SD, 0, BD, 0],
        fill: [BD, 0, 0, BD, SD, 0, TM, 0, TM, 0, SD, 0, SD, 0, TM, CY]
    },
    {
        name: "BREAK",
        bar: [BD, 0, 0, SD, 0, 0, BD, 0, SD, 0, 0, BD, 0, SD, 0, 0],
        fill: [BD, 0, SD, 0, TM, 0, TM, 0, SD, 0, TM, 0, SD, TM, SD, CY]
    },
    {
        name: "HALF",
        bar: [BD, 0, 0, 0, 0, 0, 0, 0, SD, 0, 0, 0, 0, 0, BD, 0],
        fill: [BD, 0, 0, 0, 0, 0, TM, 0, SD, 0, 0, TM, 0, 0, SD, CY]
    }
];

const HAT_PATTERNS: ReadonlyArray<readonly number[]> = [
    [2, 0, 1, 0, 2, 0, 1, 0, 2, 0, 1, 0, 2, 0, 1, 1],
    [2, 1, 1, 1, 2, 1, 1, 1, 2, 1, 1, 1, 2, 1, 1, 1],
    [2, 0, 0, 0, 1, 0, 2, 0, 0, 0, 2, 0, 1, 0, 1, 0],
    [0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 2, 0, 2]
];

/**
 * The OPLL's rhythm mode: the last three melody channels become five drums,
 * which is the trade every MSX-MUSIC game made. The cymbal is spent on the top
 * of the phrase rather than on the beat, since there is only one of it.
 */
function makeDrums(random: Random, groove: Groove): Uint8Array {
    const steps = new Uint8Array(STEPS);
    for (let bar = 0; bar < BARS; ++bar) {
        const source = bar === BARS - 1 ? groove.fill : groove.bar;
        for (let step = 0; step < STEPS_PER_BAR; ++step) {
            let mask = source[step];
            // A ghost note here and there, so eight bars of a loop are not
            // eight copies of one bar.
            if (mask === 0 && step % 2 === 1 && random.chance(0.06)) mask = BD;
            steps[bar * STEPS_PER_BAR + step] = mask;
        }
    }
    steps[0] |= CY;
    return steps;
}

function makeHats(random: Random): Uint8Array {
    const pattern = random.pick(HAT_PATTERNS);
    const steps = new Uint8Array(STEPS);
    for (let step = 0; step < STEPS; ++step) steps[step] = pattern[step % STEPS_PER_BAR];
    return steps;
}

// --- Putting one together ----------------------------------------------------

/** What a regeneration is allowed to keep from the phrase before it. */
interface Keep {
    key?: number;
    mode?: Mode;
    bpm?: number;
    chords?: readonly Chord[];
}

function makePhrase(seed: number, groove: Groove, keep: Keep = {}): Phrase {
    const random = new Random(seed);
    const key = keep.key ?? random.int(12);
    const mode = keep.mode ?? random.pick(MODES);
    const bpm = keep.bpm ?? random.pick(TEMPOS);
    const chords = keep.chords ?? makeChords(random, key, mode);

    const lead = makeLead(random, chords);
    return {
        seed, key, mode, bpm, chords,
        notes: {
            pad: makePad(chords),
            lead,
            bass: makeBass(random, chords),
            arp: makeArp(random, chords),
            echo: makeEcho(lead)
        },
        // Drawn from a generator of their own, so re-rolling the groove on the
        // desk leaves every other note of the phrase exactly where it was.
        drums: makeDrums(new Random(seed ^ 0x9e3779b9), groove),
        hats: makeHats(new Random(seed ^ 0x85ebca6b))
    };
}

// --- The desk ----------------------------------------------------------------

/** The OPLL's sixteen instruments, short enough for a cell on the desk. */
const OPLL_VOICES = [
    "CUSTOM", "VIOLIN", "GUITAR", "PIANO", "FLUTE", "CLARIN", "OBOE", "TRUMPT",
    "ORGAN", "HORN", "SYNTH", "HARPSI", "VIBES", "SYNBAS", "ACBASS", "ELGTR"
];

/**
 * The one instrument the chip does not have in ROM: eight registers holding a
 * two-operator patch, and only one of them for the whole chip. Two parts set to
 * CUSTOM share it, because on a YM2413 they have to.
 *
 * Sustained, with the modulator an octave up and enough feedback to buzz:
 * multiplier and envelope for each operator, the modulator's level, feedback,
 * then attack/decay and sustain/release for both.
 */
const CUSTOM_PATCH = [0x22, 0x21, 0x18, 0x03, 0xf0, 0xf0, 0x07, 0x08];

/** PSG voices, as the levels a driver writes on each frame of a note. */
interface PsgVoice {
    readonly name: string;
    readonly levels: readonly number[];
    /** Noise period, for the part that is nothing but noise. Zero means a tone. */
    readonly noise: number;
}

/**
 * The PSG has an envelope generator, and it is nearly useless for this: one
 * generator shared by three channels, and a channel handed to it gives up its
 * own volume. So the envelopes here are the ones MSX drivers actually used -
 * a table of levels, one written per frame, per channel, which leaves the
 * fader on the desk meaning something.
 */
const PSG_VOICES: readonly PsgVoice[] = [
    { name: "PLUCK", levels: [15, 13, 11, 9, 8, 7, 6, 5, 4, 3, 2, 2, 1, 1, 0], noise: 0 },
    { name: "BLIP", levels: [15, 11, 6, 2, 0], noise: 0 },
    { name: "SOFT", levels: [7, 10, 12, 12, 11, 11, 10], noise: 0 },
    { name: "SWELL", levels: [0, 2, 5, 8, 10, 12, 13, 14, 15], noise: 0 }
];

const HAT_VOICES: readonly PsgVoice[] = [
    { name: "TICK", levels: [15, 9, 4, 1, 0], noise: 2 },
    { name: "OPEN", levels: [15, 13, 11, 9, 7, 5, 3, 2, 1, 0], noise: 5 },
    { name: "WASH", levels: [12, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0], noise: 12 },
    { name: "METAL", levels: [15, 10, 6, 3, 1, 0], noise: 1 }
];

/** How fast a PSG note falls away once its gate has closed. */
const PSG_RELEASE = 4;

interface Part {
    readonly id: PartId;
    /** Four characters: the desk has room for no more. */
    readonly name: string;
    readonly color: number;
    /** What its voice cell cycles through. */
    readonly voices: readonly string[];
    volume: number;
    voice: number;
    muted: boolean;
    /** Frames left of the flash on its indicator. */
    flash: number;
}

function newParts(): Part[] {
    const part = (id: PartId, name: string, color: number, voices: readonly string[], volume: number, voice: number): Part =>
        ({ id, name, color, voices, volume, voice, muted: false, flash: 0 });

    return [
        part("pad", "PAD", C.PAD, OPLL_VOICES, 10, INSTRUMENT.ORGAN),
        part("lead", "LEAD", C.LEAD, OPLL_VOICES, 12, INSTRUMENT.TRUMPET),
        part("bass", "BASS", C.BASS, OPLL_VOICES, 12, INSTRUMENT.ACOUSTIC_BASS),
        part("drum", "DRUM", C.DRUM, GROOVES.map((groove) => groove.name), 12, 0),
        part("arp", "ARP", C.ARP, PSG_VOICES.map((voice) => voice.name), 10, 0),
        part("echo", "ECHO", C.ECHO, PSG_VOICES.map((voice) => voice.name), 9, 1),
        part("hat", "HAT", C.HAT, HAT_VOICES.map((voice) => voice.name), 9, 0)
    ];
}

/**
 * What a part is allowed to be voiced as, and who it shares that pool with.
 * The chip's instruments sorted by the job they can hold down rather than by
 * number: a pad wants something that sustains, a bass wants the bottom of the
 * chip, and the two of them wanting different things is the only reason the
 * seven parts stay seven parts. Parts in the same family never land on the
 * same voice, so the pad and the lead cannot quietly become one instrument.
 *
 * The drums are not here. Their cell is a groove rather than a timbre, and
 * re-rolling it would move notes rather than recolour them.
 */
const VOICE_POOL: Partial<Record<PartId, { family: string; pool: readonly number[] }>> = {
    pad: {
        family: "fm",
        pool: [INSTRUMENT.ORGAN, INSTRUMENT.CLARINET, INSTRUMENT.VIOLIN,
               INSTRUMENT.HORN, INSTRUMENT.SYNTHESIZER, INSTRUMENT.CUSTOM]
    },
    lead: {
        family: "fm",
        pool: [INSTRUMENT.TRUMPET, INSTRUMENT.FLUTE, INSTRUMENT.OBOE,
               INSTRUMENT.VIOLIN, INSTRUMENT.SYNTHESIZER, INSTRUMENT.ELECTRIC_GUITAR]
    },
    bass: {
        family: "fm",
        pool: [INSTRUMENT.ACOUSTIC_BASS, INSTRUMENT.SYNTHESIZER_BASS,
               INSTRUMENT.GUITAR, INSTRUMENT.PIANO]
    },
    arp: { family: "psg", pool: PSG_VOICES.map((_, i) => i) },
    echo: { family: "psg", pool: PSG_VOICES.map((_, i) => i) },
    hat: { family: "hat", pool: HAT_VOICES.map((_, i) => i) }
};

/**
 * New colours for a new piece: every part off the voice it was on, and off
 * the ones its family has already taken. The desk is left otherwise alone -
 * levels and mutes are the listener's, not the machine's.
 */
function revoice(random: Random): void {
    const taken = new Map<string, Set<number>>();

    for (const part of parts) {
        const entry = VOICE_POOL[part.id];
        if (!entry) continue;

        let used = taken.get(entry.family);
        if (!used) taken.set(entry.family, (used = new Set()));

        const free = entry.pool.filter((voice) => voice !== part.voice && !used.has(voice));
        // A pool small enough to be used up falls back to the whole of itself,
        // which is a repeat rather than a part with nothing to play.
        part.voice = random.pick(free.length > 0 ? free : entry.pool);
        used.add(part.voice);
    }

    dirty.mixer = true;
}

/** Which OPLL channel each FM part sings on. Rhythm mode claims 6, 7 and 8. */
const PAD_CHANNELS: readonly OpllChannel[] = [0, 1, 2, 3];
const LEAD_CHANNEL: OpllChannel = 4;
const BASS_CHANNEL: OpllChannel = 5;

/** A voice the OPLL is holding, and the frames left before it is released. */
interface FmVoice {
    gate: number;
    /** The part that owns it, so a fader move reaches a note already sounding. */
    part: Part | null;
    accent: boolean;
}

/** A voice the PSG is holding, stepped by the driver every frame. */
interface PsgSlot {
    part: Part | null;
    levels: readonly number[];
    index: number;
    gate: number;
    level: number;
    /** How hard the note was struck, out of 15. */
    gain: number;
    noise: number;
    playing: boolean;
}

// --- State -------------------------------------------------------------------

/** The phrase the demo always opens on, so it has a tune of its own. */
const FIRST_SEED = 0x5ea51de;

/** What the next turn of the loop will change, when it is left to itself. */
const CHANGES = ["MELODY", "CHORDS", "MELODY", "KEY"] as const;

let parts: Part[] = newParts();
let phrase: Phrase = makePhrase(FIRST_SEED, GROOVES[0]);
let byStep: Record<Melodic, Note[][]> = indexNotes(phrase);

const fm: FmVoice[] = [];
const psgSlots: PsgSlot[] = [];

const state = {
    /** Frames since the phrase started, and the exact position that gives. */
    frames: 0,
    position: 0,
    stepCount: 0,
    loops: 0,
    auto: true,
    /** Which fader the mouse is dragging, if any. */
    drag: -1,
    /** What the mouse is over, as a key, so a change of it can repaint. */
    hover: "",
    /** The row the joystick is on, for a machine with no mouse. */
    selected: 0,
    /** Where the playhead was drawn last, in roll columns. */
    head: -1
};

const dirty = { header: true, lane: true, roll: true, mixer: true };

/** The bar the lane was last drawn for. */
let lastBar = -1;

/** The roll, kept as one byte a pixel so a column of it can be put back. */
const roll = new Uint8Array(ROLL_W * ROLL_H);
/** The pitches the current roll is scaled to. */
let rollLow = 0;
let rollHigh = 1;

function partOf(id: PartId): Part {
    return parts.find((part) => part.id === id)!;
}

/** Every note of every part, bucketed by the step it starts on. */
function indexNotes(source: Phrase): Record<Melodic, Note[][]> {
    const index = {} as Record<Melodic, Note[][]>;
    for (const id of MELODIC) {
        const steps: Note[][] = Array.from({ length: STEPS }, () => []);
        for (const note of source.notes[id]) steps[note.step % STEPS].push(note);
        index[id] = steps;
    }
    return index;
}

/** A seed for the next phrase. The first one is fixed; the rest are not. */
function nextSeed(): number {
    return (Math.random() * 0x100000000) >>> 0;
}

// --- Driving the chips -------------------------------------------------------

/**
 * The rhythm channels need a pitch like any other: the drums are made from the
 * same phase generators as the melody voices, and a channel left at F-number
 * zero never advances its phase, so the hi-hat and the cymbal - which are two
 * phase counters beaten against each other - come out silent. This is roughly
 * 97Hz, low enough for the bass drum and fast enough for the metal.
 */
const RHYTHM_FNUM = 0x100;
const RHYTHM_BLOCK = 2;

/** Frames an indicator stays lit after its part plays something. */
const FLASH = 5;

/** Attenuation for a part, which is what the OPLL's volume nibble actually is. */
function attenuation(part: Part, accent: boolean): number {
    if (part.muted) return 15;
    return 15 - clamp(part.volume - (accent ? 0 : 1), 0, 15);
}

function gateFrames(note: Note): number {
    return Math.max(1, Math.round(note.length * framesPerStep(phrase.bpm) * 0.85));
}

function hzOf(pitch: number): number {
    return semitoneToHz(pitchOf(phrase.key, phrase.mode, pitch));
}

function resetVoices(): void {
    fm.length = 0;
    for (let i = 0; i < 6; ++i) fm.push({ gate: 0, part: null, accent: false });
    psgSlots.length = 0;
    for (let i = 0; i < 3; ++i) {
        psgSlots.push({ part: null, levels: [0], index: 0, gate: 0, level: 0, gain: 15, noise: 0, playing: false });
    }
}

function setupChips(ctx: Context): void {
    const { psg, opll } = ctx.bios.system;

    opll.reset();
    opll.setCustomInstrument(CUSTOM_PATCH);
    opll.setRhythmMode(true);
    for (const channel of [6, 7, 8] as const) opll.setFrequency(channel, RHYTHM_FNUM, RHYTHM_BLOCK);
    writeDrumVolume(ctx);

    psg.reset();
    psg.setMixer([false, false, false]);
    resetVoices();
}

/**
 * Drum levels. In rhythm mode the OPLL stops using the instrument nibble of
 * these three registers and spends it on a second volume instead: the bass drum
 * has a register to itself, while the snare shares one with the hi-hat and the
 * tom with the cymbal, a nibble each.
 */
function writeDrumVolume(ctx: Context): void {
    const { opll } = ctx.bios.system;
    const part = partOf("drum");
    const level = part.muted ? 15 : 15 - part.volume;
    opll.write(OPLL_R.INSTRUMENT + 6, level);
    opll.write(OPLL_R.INSTRUMENT + 7, (level << 4) | level);
    opll.write(OPLL_R.INSTRUMENT + 8, (level << 4) | level);
}

function fmNote(ctx: Context, channel: OpllChannel, part: Part, note: Note): void {
    if (part.muted) return;
    const { opll } = ctx.bios.system;
    part.flash = FLASH;

    const voice = fm[channel];
    voice.part = part;
    voice.accent = note.accent;
    voice.gate = gateFrames(note);

    // Key off before anything else: the chip restarts the envelope on the
    // rising edge of the key bit and nowhere else.
    opll.setKeyOn(channel, false);
    opll.setInstrument(channel, part.voice, attenuation(part, note.accent));
    opll.setPitch(channel, hzOf(note.pitch));
    opll.setKeyOn(channel, true);
}

function psgNote(ctx: Context, channel: Channel, part: Part, note: Note): void {
    if (part.muted) return;
    const { psg } = ctx.bios.system;
    part.flash = FLASH;

    const voice = PSG_VOICES[part.voice % PSG_VOICES.length];
    const slot = psgSlots[channel];
    slot.part = part;
    slot.levels = voice.levels;
    slot.index = 0;
    slot.gate = gateFrames(note);
    slot.level = voice.levels[0];
    slot.gain = note.accent ? 15 : 12;
    slot.noise = 0;
    slot.playing = true;
    psg.setTone(channel, hzOf(note.pitch));
}

/** The noise generator, which is the whole of the PSG's percussion. */
function psgHat(ctx: Context, part: Part, velocity: number): void {
    if (part.muted) return;
    const { psg } = ctx.bios.system;
    part.flash = FLASH;

    const voice = HAT_VOICES[part.voice % HAT_VOICES.length];
    const slot = psgSlots[2];
    slot.part = part;
    slot.levels = voice.levels;
    slot.index = 0;
    // The table is the whole envelope here, so it is given the run of it.
    slot.gate = voice.levels.length;
    slot.level = voice.levels[0];
    slot.gain = velocity >= 2 ? 15 : 9;
    slot.noise = voice.noise;
    slot.playing = true;
    psg.setNoisePeriod(voice.noise);
}

/** One step of the sequence, which is the only thing that writes a note on. */
function fire(ctx: Context, step: number): void {
    byStep.pad[step].forEach((note, i) => {
        if (i < PAD_CHANNELS.length) fmNote(ctx, PAD_CHANNELS[i], partOf("pad"), note);
    });
    for (const note of byStep.lead[step]) fmNote(ctx, LEAD_CHANNEL, partOf("lead"), note);
    for (const note of byStep.bass[step]) fmNote(ctx, BASS_CHANNEL, partOf("bass"), note);
    for (const note of byStep.arp[step]) psgNote(ctx, 0, partOf("arp"), note);
    for (const note of byStep.echo[step]) psgNote(ctx, 1, partOf("echo"), note);

    const drums = phrase.drums[step];
    const drum = partOf("drum");
    if (drums !== 0 && !drum.muted) {
        drum.flash = FLASH;
        ctx.bios.system.opll.triggerRhythm(drums);
    }
    if (phrase.hats[step] !== 0) psgHat(ctx, partOf("hat"), phrase.hats[step]);
}

/**
 * The frame's worth of register writes: gates counted down, PSG envelopes
 * stepped. This is the whole of what an MSX music driver did on the vertical
 * interrupt, and it is why the faders are live - a level moved between two
 * notes reaches the note already sounding.
 */
function tickVoices(ctx: Context): void {
    const { psg, opll } = ctx.bios.system;

    for (let channel = 0; channel < fm.length; ++channel) {
        const voice = fm[channel];
        if (voice.gate <= 0) continue;
        if (voice.part) opll.setVolume(channel as OpllChannel, attenuation(voice.part, voice.accent));
        if (--voice.gate === 0) opll.setKeyOn(channel as OpllChannel, false);
    }

    const tone = [false, false, false];
    const noise = [false, false, false];
    for (let channel = 0; channel < 3; ++channel) {
        const slot = psgSlots[channel];
        if (!slot.playing) {
            psg.setVolume(channel as Channel, 0);
            continue;
        }

        if (slot.gate > 0) {
            --slot.gate;
            slot.level = slot.levels[Math.min(slot.index, slot.levels.length - 1)];
            ++slot.index;
        } else {
            slot.level = Math.max(0, slot.level - PSG_RELEASE);
        }

        const part = slot.part;
        const out = part && !part.muted
            ? Math.round((slot.level * part.volume * slot.gain) / 225)
            : 0;
        psg.setVolume(channel as Channel, out);

        if (slot.level === 0 && slot.gate === 0) slot.playing = false;
        else if (slot.noise > 0) noise[channel] = true;
        else tone[channel] = true;
    }
    psg.setMixer(tone, noise);
}

/** Lets go of everything, for a phrase that is about to be replaced. */
function allOff(ctx: Context): void {
    const { psg, opll } = ctx.bios.system;
    for (let channel = 0; channel < fm.length; ++channel) {
        opll.setKeyOn(channel as OpllChannel, false);
        fm[channel].gate = 0;
        fm[channel].part = null;
    }
    for (let channel = 0; channel < 3; ++channel) {
        psgSlots[channel].playing = false;
        psg.setVolume(channel as Channel, 0);
    }
    psg.setMixer([false, false, false]);
}

/** Silences one part at once, for a mute that has to be heard immediately. */
function hush(ctx: Context, part: Part): void {
    const { psg, opll } = ctx.bios.system;
    for (let channel = 0; channel < fm.length; ++channel) {
        if (fm[channel].part !== part) continue;
        opll.setKeyOn(channel as OpllChannel, false);
        fm[channel].gate = 0;
    }
    for (let channel = 0; channel < 3; ++channel) {
        if (psgSlots[channel].part !== part) continue;
        psgSlots[channel].playing = false;
        psg.setVolume(channel as Channel, 0);
    }
    if (part.id === "drum") writeDrumVolume(ctx);
}

// --- The sequence ------------------------------------------------------------

function restart(ctx: Context): void {
    allOff(ctx);
    state.frames = 0;
    state.position = 0;
    state.stepCount = 0;
    fire(ctx, 0);
}

/** Takes a new phrase, with the desk left exactly as it was. */
function load(ctx: Context, next: Phrase, fromTheTop = true): void {
    phrase = next;
    byStep = indexNotes(phrase);
    buildRoll();
    dirty.header = true;
    dirty.lane = true;
    dirty.roll = true;
    state.head = -1;
    if (fromTheTop) restart(ctx);
}

type Change = (typeof CHANGES)[number];

/**
 * A new phrase, keeping as much of the old one as the change allows: a new
 * melody over the same harmony, new harmony in the same key, or everything.
 */
function regenerate(ctx: Context, change: Change, fromTheTop = true): void {
    const settled = { key: phrase.key, mode: phrase.mode, bpm: phrase.bpm };
    const keep: Keep =
        change === "KEY" ? {}
        : change === "CHORDS" ? settled
        : { ...settled, chords: phrase.chords };

    const seed = nextSeed();
    // A new key is a whole new piece, so it arrives in new colours as well as
    // new notes: the voices are re-drawn before the phrase is, and the parts
    // pick their instrument up on the next note they key on.
    if (change === "KEY") revoice(new Random(seed ^ 0xc2b2ae35));

    load(ctx, makePhrase(seed, GROOVES[partOf("drum").voice], keep), fromTheTop);
}

/** One bar of the progression, redrawn - and the parts written over it again. */
function rerollChord(ctx: Context, bar: number): void {
    const random = new Random(nextSeed());
    const before = phrase.chords[(bar + BARS - 1) % BARS].degree;
    let degree = random.weighted(AFTER[before]);
    if (degree === before) degree = random.weighted(AFTER[before]);

    const chords = phrase.chords.map((chord, i) =>
        i === bar ? chordOn(phrase.key, phrase.mode, degree, random.chance(SEVENTHS[degree])) : chord);

    load(ctx, makePhrase(nextSeed(), GROOVES[partOf("drum").voice],
        { key: phrase.key, mode: phrase.mode, bpm: phrase.bpm, chords }), false);
}

/** The end of the phrase. Returns true when it started a different one. */
function turnOver(ctx: Context): boolean {
    const change = CHANGES[state.loops % CHANGES.length];
    ++state.loops;
    dirty.header = true;
    if (!state.auto) return false;
    regenerate(ctx, change);
    return true;
}

function advance(ctx: Context): void {
    ++state.frames;
    state.position = state.frames / framesPerStep(phrase.bpm);

    while (state.stepCount < Math.floor(state.position)) {
        ++state.stepCount;
        const step = state.stepCount % STEPS;
        // A phrase that turns into a different one starts itself, so there is
        // nothing left of this step to play.
        if (step === 0 && turnOver(ctx)) break;
        fire(ctx, step);
    }
}

// --- Drawing -----------------------------------------------------------------
//
// All of it immediate. The blitter draws at the V9938's own pace, which is
// right for a picture arriving and wrong for a control that has to be under
// the mouse this frame - so `gfx.now` writes straight into VRAM, and the desk
// is only ever redrawn where something changed.

type Ink = Context["gfx"]["now"];

function box(g: Ink, x: number, y: number, width: number, height: number, fill: number, border: number): void {
    g.fillRect(x, y, width, height, fill);
    g.rect(x, y, width, height, border);
}

/** Centres a string in a box, in the machine's own six-pixel font. */
function centred(g: Ink, x: number, width: number, y: number, text: string, color: number): void {
    g.text(x + ((width - text.length * CHAR) >> 1), y, text, color);
}

function button(g: Ink, x: number, width: number, label: string, on: boolean, hovered: boolean): void {
    box(g, x, 0, width, HEADER_H - 1, on ? C.EDGE : C.PANEL, hovered ? C.ACCENT : C.GRID);
    centred(g, x, width, 1, label, on ? C.BRIGHT : C.DIM);
}

function paintHeader(ctx: Context): void {
    const g = ctx.gfx.now;
    g.fillRect(0, 0, WIDTH, HEADER_H, C.BACK);

    const tonic = noteNames(phrase.key, phrase.mode)[phrase.key];
    g.text(2, 1, "LOOM", C.ACCENT);
    g.text(30, 1, `${tonic} ${phrase.mode.name} ${phrase.bpm}BPM`, C.TEXT);

    const next = CHANGES[state.loops % CHANGES.length];
    button(g, AUTO_X, AUTO_W, state.auto ? `AUTO ${next}` : "AUTO OFF", state.auto, state.hover === "auto");
    button(g, NEW_X, NEW_W, "NEW", false, state.hover === "new");
}

/** Which bar is sounding, and how far through it the phrase has got. */
function barNow(): number {
    return Math.floor((state.position % STEPS) / STEPS_PER_BAR);
}

function paintLane(ctx: Context): void {
    const g = ctx.gfx.now;
    const current = barNow();
    g.fillRect(0, LANE_Y, WIDTH, LANE_H, C.BACK);

    phrase.chords.forEach((chord, bar) => {
        const x = CELL_X + bar * CELL_W;
        const here = bar === current;
        const hovered = state.hover === `chord:${bar}`;
        box(g, x, LANE_Y, CELL_W - 2, LANE_H, here ? C.EDGE : C.PANEL, hovered ? C.ACCENT : here ? C.ACCENT : C.GRID);
        g.text(x + 2, LANE_Y + 3, chord.numeral, here ? C.ACCENT : C.DIM);
        centred(g, x, CELL_W - 2, LANE_Y + 12, chord.name, here ? C.BRIGHT : C.TEXT);
    });
}

/** The bar going by, under the chord that owns it. */
function paintBar(ctx: Context): void {
    const g = ctx.gfx.now;
    const bar = barNow();
    const x = CELL_X + bar * CELL_W + 2;
    const width = CELL_W - 6;
    const through = ((state.position % STEPS_PER_BAR) / STEPS_PER_BAR) * width;

    g.fillRect(x, LANE_Y + LANE_H - 4, width, 2, C.GRID);
    g.fillRect(x, LANE_Y + LANE_H - 4, Math.max(1, Math.round(through)), 2, C.ACCENT);
}

// --- The roll ----------------------------------------------------------------

/** Rows of the roll each drum lands on, inside the model. */
const HAT_ROW = NOTE_H + 2;
const CYMBAL_ROW = NOTE_H + 5;
const SNARE_ROW = NOTE_H + 8;
const KICK_ROW = NOTE_H + 11;

const stepX = (step: number): number => Math.floor((step * ROLL_W) / STEPS);

function rollY(pitch: number): number {
    const span = Math.max(1, rollHigh - rollLow);
    return Math.round(((rollHigh - pitch) * (NOTE_H - 3)) / span);
}

function mark(x: number, y: number, width: number, height: number, color: number): void {
    for (let row = y; row < y + height && row < ROLL_H; ++row) {
        if (row < 0) continue;
        const base = row * ROLL_W;
        for (let column = x; column < x + width && column < ROLL_W; ++column) {
            if (column >= 0) roll[base + column] = color;
        }
    }
}

/**
 * The whole phrase as a picture: every note of it at once, scaled to whatever
 * range the parts happen to cover this time. Built into a byte-a-pixel model
 * rather than drawn, because the playhead has to be able to put back exactly
 * what it passed over.
 */
function buildRoll(): void {
    roll.fill(C.PANEL);

    rollLow = 127;
    rollHigh = 0;
    for (const id of MELODIC) {
        for (const note of phrase.notes[id]) {
            const pitch = pitchOf(phrase.key, phrase.mode, note.pitch);
            if (pitch < rollLow) rollLow = pitch;
            if (pitch > rollHigh) rollHigh = pitch;
        }
    }
    if (rollHigh <= rollLow) rollHigh = rollLow + 1;

    // Bar lines, and the rule the drums hang under.
    for (let bar = 0; bar < BARS; ++bar) mark(stepX(bar * STEPS_PER_BAR), 0, 1, NOTE_H, C.EDGE);
    mark(0, NOTE_H, ROLL_W, 1, C.EDGE);

    // Quietest part first: the lead is what should survive an overlap.
    for (const id of ["echo", "pad", "arp", "bass", "lead"] as const) {
        const part = partOf(id);
        for (const note of phrase.notes[id]) {
            const x = stepX(note.step);
            const width = Math.max(1, stepX(note.step + note.length) - x - 1);
            mark(x, rollY(pitchOf(phrase.key, phrase.mode, note.pitch)), width, 2,
                part.muted ? C.EDGE : part.color);
        }
    }

    const drum = partOf("drum");
    const hat = partOf("hat");
    for (let step = 0; step < STEPS; ++step) {
        const x = stepX(step);
        const width = Math.max(1, stepX(step + 1) - x - 1);
        const drums = phrase.drums[step];
        if (phrase.hats[step] !== 0) {
            mark(x, HAT_ROW, width, phrase.hats[step] >= 2 ? 2 : 1, hat.muted ? C.EDGE : C.HAT);
        }
        if (drums & (CY | TM)) mark(x, CYMBAL_ROW, width, 2, drum.muted ? C.EDGE : C.DRUM);
        if (drums & SD) mark(x, SNARE_ROW, width, 2, drum.muted ? C.EDGE : C.DRUM);
        if (drums & BD) mark(x, KICK_ROW, width, 2, drum.muted ? C.EDGE : C.DRUM);
    }
}

function paintRoll(ctx: Context): void {
    ctx.gfx.now.drawImage(ROLL_X, ROLL_Y, ROLL_W, ROLL_H, roll, false);
}

const column = new Uint8Array(ROLL_H);

function putColumn(ctx: Context, at: number, head: boolean): void {
    for (let row = 0; row < ROLL_H; ++row) {
        const under = roll[row * ROLL_W + at];
        // The head brightens whatever it crosses rather than hiding it.
        column[row] = !head ? under
            : under === C.PANEL || under === C.EDGE ? C.ACCENT
            : C.BRIGHT;
    }
    ctx.gfx.now.drawImage(ROLL_X + at, ROLL_Y, 1, ROLL_H, column, false);
}

/** Moves the playhead, putting the roll back behind it as it goes. */
function paintHead(ctx: Context): void {
    const at = Math.min(ROLL_W - 1, Math.floor(((state.position % STEPS) * ROLL_W) / STEPS));
    if (at === state.head) return;

    if (state.head >= 0) {
        let put = state.head;
        while (put !== at) {
            putColumn(ctx, put, false);
            put = (put + 1) % ROLL_W;
        }
    }
    putColumn(ctx, at, true);
    state.head = at;
}

// --- The desk ----------------------------------------------------------------

/** What each indicator was last drawn as, so it is only redrawn when it moves. */
const lamps = new Int8Array(8).fill(-1);

function lampColor(part: Part): number {
    return part.muted ? C.MUTED : part.flash > 0 ? C.BRIGHT : part.color;
}

function paintRow(ctx: Context, row: number): void {
    const g = ctx.gfx.now;
    const part = parts[row];
    const top = MIXER_Y + row * ROW_H;

    g.fillRect(0, top, WIDTH, ROW_H, C.BACK);
    if (row === state.selected) g.fillRect(0, top + 2, 2, 7, C.ACCENT);

    lamps[row] = lampColor(part);
    box(g, LED_X, top + 2, LED_W, 7, lamps[row], state.hover === `mute:${row}` ? C.ACCENT : C.EDGE);
    g.text(NAME_X, top + 2, part.name, part.muted ? C.DIM : C.TEXT);

    const voice = state.hover === `voice:${row}`;
    box(g, VOICE_X, top + 1, VOICE_W, 9, C.PANEL, voice ? C.ACCENT : C.GRID);
    g.text(VOICE_X + 1, top + 2, "<", voice ? C.TEXT : C.DIM);
    g.text(VOICE_X + VOICE_W - 7, top + 2, ">", voice ? C.TEXT : C.DIM);
    centred(g, VOICE_X + 6, VOICE_W - 12, top + 2, part.voices[part.voice], part.muted ? C.DIM : C.TEXT);

    paintFader(ctx, row);
}

function paintFader(ctx: Context, row: number): void {
    const g = ctx.gfx.now;
    const part = parts[row];
    const top = MIXER_Y + row * ROW_H;
    const color = part.muted ? C.MUTED : part.color;

    for (let cell = 0; cell < 16; ++cell) {
        g.fillRect(FADER_X + cell * FADER_CELL, top + 3, FADER_CELL - 1, 5, cell < part.volume ? color : C.GRID);
    }
    g.text(LEVEL_X, top + 2, String(part.volume).padStart(2, " "), part.muted ? C.DIM : C.TEXT);
}

function paintMixer(ctx: Context): void {
    for (let row = 0; row < parts.length; ++row) paintRow(ctx, row);
}

/** The indicators, which are the only part of the desk that moves by itself. */
function paintLamps(ctx: Context): void {
    for (let row = 0; row < parts.length; ++row) {
        const color = lampColor(parts[row]);
        if (color === lamps[row]) continue;
        lamps[row] = color;
        ctx.gfx.now.fillRect(LED_X + 1, MIXER_Y + row * ROW_H + 3, LED_W - 2, 5, color);
    }
}

// --- The cursor --------------------------------------------------------------
//
// Two sprites: the arrow, and the same arrow one pixel down and right in the
// panel colour behind it. The VDP composites both for nothing, and a shadow is
// what makes a white arrow readable over a white fader - one sprite could not
// have done it, since a sprite is one colour to a line.

const ARROW = [
    "X.......",
    "XX......",
    "XXX.....",
    "XXXX....",
    "XXXXX...",
    "XXXXXX..",
    "XXXX....",
    "X..XX..."
];

function moveCursor(ctx: Context): void {
    const { pointer, sprites } = ctx;
    if (!pointer.present || !pointer.inside) {
        sprites.hide(0);
        sprites.hide(1);
        return;
    }
    sprites.move(0, pointer.x, pointer.y);
    sprites.move(1, pointer.x + 1, pointer.y + 1);
}

// --- What the mouse is on ----------------------------------------------------

/** Everything on the screen that can be clicked, named. */
function hit(x: number, y: number): string {
    if (y < HEADER_H) {
        if (x >= AUTO_X && x < AUTO_X + AUTO_W) return "auto";
        if (x >= NEW_X && x < NEW_X + NEW_W) return "new";
        return "";
    }

    if (y >= LANE_Y && y < LANE_Y + LANE_H) {
        const bar = Math.floor((x - CELL_X) / CELL_W);
        if (bar < 0 || bar >= BARS) return "";
        return x < CELL_X + bar * CELL_W + CELL_W - 2 ? `chord:${bar}` : "";
    }

    if (y >= MIXER_Y) {
        const row = Math.floor((y - MIXER_Y) / ROW_H);
        if (row < 0 || row >= parts.length) return "";
        // The name is part of the mute, since it is a bigger thing to hit.
        if (x >= LED_X && x < VOICE_X - 2) return `mute:${row}`;
        if (x >= VOICE_X && x < VOICE_X + VOICE_W) return `voice:${row}`;
        if (x >= FADER_X - 2 && x < LEVEL_X) return `fader:${row}`;
    }
    return "";
}

/** Which part of the picture a target lives in, so only that part is redrawn. */
function markHover(key: string): void {
    if (key === "auto" || key === "new") dirty.header = true;
    else if (key.startsWith("chord")) dirty.lane = true;
    else if (key !== "") dirty.mixer = true;
}

const rowOf = (key: string): number => Number(key.slice(key.indexOf(":") + 1));

/** Turns a place on a fader into a level. Left of the first cell is silence. */
function levelAt(x: number): number {
    return clamp(Math.floor((x - FADER_X) / FADER_CELL) + 1, 0, 15);
}

function toggleMute(ctx: Context, row: number): void {
    const part = parts[row];
    part.muted = !part.muted;
    hush(ctx, part);
    // Muted parts stay in the roll as ghosts, so what is missing can be seen.
    buildRoll();
    dirty.roll = true;
    dirty.mixer = true;
}

function cycleVoice(ctx: Context, row: number, by: number): void {
    const part = parts[row];
    part.voice = (part.voice + by + part.voices.length) % part.voices.length;
    dirty.mixer = true;

    if (part.id === "drum") {
        // The drums have a generator of their own, so a new groove re-rolls
        // them and leaves every other note of the phrase where it was.
        load(ctx, { ...phrase, drums: makeDrums(new Random(phrase.seed ^ 0x9e3779b9), GROOVES[part.voice]) }, false);
    }
}

function press(ctx: Context, key: string, x: number): void {
    if (key === "new") {
        regenerate(ctx, "KEY");
        state.loops = 0;
    } else if (key === "auto") {
        state.auto = !state.auto;
        dirty.header = true;
    } else if (key.startsWith("chord")) {
        rerollChord(ctx, rowOf(key));
    } else if (key.startsWith("mute")) {
        toggleMute(ctx, rowOf(key));
    } else if (key.startsWith("voice")) {
        cycleVoice(ctx, rowOf(key), x < VOICE_X + 12 ? -1 : 1);
    } else if (key.startsWith("fader")) {
        const row = rowOf(key);
        state.drag = row;
        state.selected = row;
        parts[row].volume = levelAt(x);
        dirty.mixer = true;
    }
}

function readMouse(ctx: Context): void {
    const { pointer } = ctx;

    // A drag owns the fader it started on until the button comes up, wherever
    // the mouse has got to since - which is what the host's pointer capture is
    // for, and why the level below is clamped rather than hit-tested again.
    if (state.drag >= 0) {
        const part = parts[state.drag];
        const level = levelAt(pointer.x);
        if (level !== part.volume) {
            part.volume = level;
            dirty.mixer = true;
            if (part.id === "drum") writeDrumVolume(ctx);
        }
        if (!pointer.down()) state.drag = -1;
        return;
    }

    const key = pointer.inside ? hit(pointer.x, pointer.y) : "";
    if (key !== state.hover) {
        markHover(state.hover);
        markHover(key);
        state.hover = key;
    }
    if (pointer.pressed() && key !== "") press(ctx, key, pointer.x);
}

/** The same desk from a joystick, for a machine with no mouse on it. */
function readJoystick(ctx: Context): void {
    const { input, frame } = ctx;

    if (input.btnp(BUTTON.B)) {
        regenerate(ctx, "KEY");
        state.loops = 0;
    }
    if (input.btnp(BUTTON.A)) cycleVoice(ctx, state.selected, 1);
    if (input.btnp(BUTTON.UP)) {
        state.selected = (state.selected + parts.length - 1) % parts.length;
        dirty.mixer = true;
    }
    if (input.btnp(BUTTON.DOWN)) {
        state.selected = (state.selected + 1) % parts.length;
        dirty.mixer = true;
    }

    // Held, and stepped every fourth frame: a fader is worth sweeping.
    const part = parts[state.selected];
    const move = (input.btn(BUTTON.RIGHT) ? 1 : 0) - (input.btn(BUTTON.LEFT) ? 1 : 0);
    if (move !== 0 && frame % 4 === 0) {
        const level = clamp(part.volume + move, 0, 15);
        if (level !== part.volume) {
            part.volume = level;
            dirty.mixer = true;
            if (part.id === "drum") writeDrumVolume(ctx);
        }
    }
}

// --- The demo ----------------------------------------------------------------

export const demo: App = {
    init(ctx: Context) {
        const { screen, gfx, sprites } = ctx;

        parts = newParts();
        state.frames = 0;
        state.position = 0;
        state.stepCount = 0;
        state.loops = 0;
        state.auto = true;
        state.drag = -1;
        state.hover = "";
        state.selected = 0;
        state.head = -1;
        lamps.fill(-1);

        screen.setMode("G4");
        screen.setPalette(PALETTE);
        screen.setBackdrop(C.BACK);

        sprites.setSize(8);
        sprites.setPatternFromBitmap(0, ARROW);
        sprites.setPatternFromBitmap(1, ARROW);
        sprites.set(0, { x: 0, y: 0, pattern: 0, color: C.BRIGHT });
        sprites.set(1, { x: 1, y: 1, pattern: 1, color: C.PANEL });
        sprites.setActiveCount(2);
        sprites.hide(0);
        sprites.hide(1);
        sprites.setEnabled(true);

        // Nothing is playing a song: the sequencer below writes the registers
        // itself, and the driver on the vertical interrupt has no tracks.
        ctx.bgm.stop();
        setupChips(ctx);

        phrase = makePhrase(FIRST_SEED, GROOVES[partOf("drum").voice]);
        byStep = indexNotes(phrase);
        buildRoll();

        gfx.now.clear(C.BACK);
        dirty.header = true;
        dirty.lane = true;
        dirty.roll = true;
        dirty.mixer = true;
        restart(ctx);
    },

    update(ctx: Context) {
        advance(ctx);
        tickVoices(ctx);
        for (const part of parts) if (part.flash > 0) --part.flash;

        readMouse(ctx);
        readJoystick(ctx);
        moveCursor(ctx);

        // The lane holds one bar at a time, so it is redrawn when the bar turns.
        if (barNow() !== lastBar) {
            lastBar = barNow();
            dirty.lane = true;
        }
    },

    draw(ctx: Context) {
        if (dirty.roll) {
            paintRoll(ctx);
            state.head = -1;
            dirty.roll = false;
        }
        if (dirty.lane) {
            paintLane(ctx);
            dirty.lane = false;
        }
        if (dirty.header) {
            paintHeader(ctx);
            dirty.header = false;
        }
        if (dirty.mixer) {
            paintMixer(ctx);
            dirty.mixer = false;
        }

        paintBar(ctx);
        paintHead(ctx);
        paintLamps(ctx);
    }
};
