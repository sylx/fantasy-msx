// Japanese input, on the machine's side of the line.
//
// The browser has an input method of its own and this deliberately does not use
// it. An OS candidate window floats over the canvas in the system's typeface at
// the system's size, which on a screen made of sixteen colours and 16x16 cells
// is not a candidate window - it is a browser drawn on top of a machine. What
// belongs to the host is the dictionary and the arithmetic over it; what belongs
// here is every decision about what appears and where.
//
// So this module holds no engine. It is a mailbox between a conversion session
// - a state machine that turns keystrokes into a preedit, candidates and
// committed text - and a frame loop that has to read all three synchronously
// while the session answers whenever it answers. `ImeSession` is the seam, and
// hechima's `FepSession` satisfies it as shipped; `host/hechima.ts` is the
// adapter that builds one, and a test supplies its own.
//
// Nothing here draws. `segments` and `candidates` are handed over as data and
// the app puts them where its own screen wants them, which is the whole reason
// for going to this trouble.

import type { KeyEvent } from "../runtime/keyboard.js";
import { textCells } from "./width.js";

/**
 * A run of the preedit. `yomi` is the reading as typed, before anything has
 * been converted; after conversion the reading is divided into clauses, of
 * which one has the attention and the rest do not.
 */
export interface ImeSegment {
    readonly text: string;
    readonly kind: "yomi" | "focus" | "other";
    /** Present on a converted clause: what else it could have been. */
    readonly candidates?: readonly string[];
    readonly candidateIndex?: number;
}

/** What a session tells the machine. The three an engine cannot do without. */
export interface ImeCallbacks {
    /** The preedit changed. */
    show(segments: readonly ImeSegment[]): void;
    /** There is no longer a preedit. */
    hide(): void;
    /** This text is settled and belongs to the document now. */
    commit(text: string): void;
}

/** One keystroke, in the shape an engine reads it - no DOM in sight. */
export interface KeyTap {
    readonly key: string;
    readonly code?: string;
    readonly repeat?: boolean;
    readonly shiftKey?: boolean;
    readonly ctrlKey?: boolean;
    readonly altKey?: boolean;
    readonly metaKey?: boolean;
}

/**
 * A conversion session: keystrokes in, callbacks out. Composition, conversion,
 * candidate cycling and learning all live behind this, which is why there is so
 * little of it here.
 */
export interface ImeSession {
    /** True when the session took the key. False hands it back to the app. */
    feed(tap: KeyTap): boolean;
    setActive(on: boolean): boolean;
    reset(): void;
    /** Choose a candidate outright, which is what a bar you can point at needs. */
    selectCandidate?(index: number): boolean;
}

/** Builds a session around the callbacks the machine wants to hear from. */
export type ImeSessionFactory = (callbacks: ImeCallbacks) => ImeSession;

export class Ime {
    private session: ImeSession | null = null;
    private preedit: readonly ImeSegment[] = [];
    private settled = "";
    private on = false;

    // --- Wiring -----------------------------------------------------------

    /**
     * Gives the machine an engine to talk to. Until this is called the IME is
     * inert and every key goes straight through, which is what an app without
     * a dictionary loaded should look like.
     */
    attach(factory: ImeSessionFactory): void {
        this.session = factory({
            show: (segments) => { this.preedit = segments; },
            hide: () => { this.preedit = []; },
            commit: (text) => {
                // A commit ends the preedit, and an engine is not obliged to
                // say so separately - hechima does not call `hide` here, and
                // its contract is that the host clears its own display before
                // it inserts the text. Leaving this out leaves the settled
                // string on screen twice: once as text, once as a preedit that
                // nothing will take away until the next keystroke.
                //
                // A partial commit reports the clauses that are left with a
                // `show` straight after this one, so clearing here is right in
                // both cases.
                this.preedit = [];
                // Committed text piles up rather than being delivered: the
                // session answers between frames and the app reads once a frame.
                this.settled += text;
            }
        });
        this.session.setActive(this.on);
    }

    get attached(): boolean {
        return this.session !== null;
    }

    /** Whether keystrokes are being converted or passed through. */
    get enabled(): boolean {
        return this.on;
    }

    set enabled(on: boolean) {
        if (on === this.on) return;
        this.on = on;
        // Turning it off throws away a half-typed reading, which is what every
        // IME does and what the key that does it is understood to mean.
        this.session?.setActive(on);
        if (!on) this.preedit = [];
    }

    // --- Reading ----------------------------------------------------------

    /** The preedit, divided the way the engine divided it. Empty when there is none. */
    get segments(): readonly ImeSegment[] {
        return this.preedit;
    }

    get composing(): boolean {
        return this.preedit.length > 0;
    }

    /** The whole preedit as one string, for measuring or for a caret. */
    get text(): string {
        let out = "";
        for (const segment of this.preedit) out += segment.text;
        return out;
    }

    /** The clause with the attention, which is the one a candidate list is about. */
    get focus(): ImeSegment | null {
        return this.preedit.find((segment) => segment.kind === "focus") ?? null;
    }

    /** What the focused clause could be instead. Empty until something is converted. */
    get candidates(): readonly string[] {
        return this.focus?.candidates ?? [];
    }

    get selected(): number {
        return this.focus?.candidateIndex ?? 0;
    }

    /** Cells the preedit occupies up to the focused clause, for placing a bar under it. */
    focusOffset(): number {
        let cells = 0;
        for (const segment of this.preedit) {
            if (segment.kind === "focus") break;
            cells += textCells(segment.text);
        }
        return cells;
    }

    // --- Driving ----------------------------------------------------------

    /**
     * Hands a frame's keystrokes to the engine and gives back the ones it did
     * not want - a cursor key with nothing being composed, say, which belongs
     * to whatever the app is editing.
     *
     * Key releases are not passed on. The chord layouts (NICOLA, and the
     * naginata arrangement hechima ships) decide what a key means by what is
     * held with it, so they need them; the romaji path does not, and the
     * keyboard here does not queue them yet.
     */
    feed(events: readonly KeyEvent[]): readonly KeyEvent[] {
        if (!this.session || !this.on) return events;

        const passed: KeyEvent[] = [];
        for (const event of events) {
            // Anything held with a platform key is a shortcut, not text.
            if (event.meta) { passed.push(event); continue; }
            if (!this.session.feed(toTap(event))) passed.push(event);
        }
        return passed;
    }

    /**
     * The text the engine settled since this was last called, and empties it.
     * It arrives whenever the engine answers, which is not inside the frame
     * that asked - so this is a mailbox rather than a return value.
     */
    takeText(): string {
        const text = this.settled;
        this.settled = "";
        return text;
    }

    /** Chooses a candidate outright, which is what a bar you can point at needs. */
    select(index: number): boolean {
        return this.session?.selectCandidate?.(index) ?? false;
    }

    /** Throws away whatever is half-typed, leaving the document alone. */
    reset(): void {
        this.session?.reset();
        this.preedit = [];
        this.settled = "";
    }
}

/** A keystroke as the machine records it, in the shape an engine reads. */
function toTap(event: KeyEvent): KeyTap {
    return {
        key: event.key,
        code: event.code,
        repeat: event.repeat,
        shiftKey: event.shift,
        ctrlKey: event.ctrl,
        altKey: event.alt,
        metaKey: event.meta
    };
}
