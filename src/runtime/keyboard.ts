// The keyboard, as something to type on rather than something to play.
//
// `Input` is the joystick: six buttons and two ports, latched once a frame, so
// `btnp` means "since the last update" no matter how many events the browser
// delivered in between. That shape is right for a game and wrong for text. A
// key held down is a level; a key *typed* is an event, and two of them in one
// frame are two characters that both have to arrive, in the order they were
// struck. So this is a queue rather than a latch, and it is the third sibling
// of `Input` and `Pointer` rather than a part of either.
//
// It carries raw keys and nothing else. There is no `insert` or `compose` here
// because the plan is for the machine to do its own kana-kanji conversion -
// which means what a host hands over is keystrokes, and every decision about
// what they mean belongs above this line.
//
// Auto-repeat is synthesised here rather than taken from the browser, so a
// headless run and a browser run produce the same events from the same keys.
// The rates are an MSX BIOS's: about half a second before the first repeat,
// then thirty a second.

/** Frames a key is held before it starts repeating. */
const REPEAT_DELAY = 30;
/** Frames between repeats once it has started. */
const REPEAT_INTERVAL = 2;
/** Events kept when nobody is reading. Past this the oldest go. */
const MAX_QUEUED = 64;

/** Keys that hold no character and must never repeat. */
const MODIFIERS = new Set(["ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight",
    "AltLeft", "AltRight", "MetaLeft", "MetaRight", "CapsLock"]);

/**
 * Keys a page would otherwise act on itself - scrolling, going back, moving
 * focus - which have to be swallowed while something on the machine is being
 * typed into. Printable keys are claimed by their length rather than listed.
 */
const CLAIMED = new Set(["Enter", "NumpadEnter", "Backspace", "Delete", "Tab", "Space",
    "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);

/** One keystroke. The fields a `KeyboardEvent` has, and only those. */
export interface KeyEvent {
    /** Physical key, by `KeyboardEvent.code` - "KeyA", "Enter", "ArrowLeft". */
    readonly code: string;
    /**
     * What the key produced, by `KeyboardEvent.key`. One character when it was
     * printable - already shifted, and already through the host's layout - and
     * a name like "Enter" or "ArrowLeft" when it was not.
     */
    readonly key: string;
    readonly shift: boolean;
    readonly ctrl: boolean;
    readonly alt: boolean;
    readonly meta: boolean;
    /** True for the repeats this class makes, false for the strike itself. */
    readonly repeat: boolean;
}

/** What a host passes in. A browser's `KeyboardEvent` already is one. */
export interface KeyLike {
    readonly code: string;
    readonly key: string;
    readonly shiftKey?: boolean;
    readonly ctrlKey?: boolean;
    readonly altKey?: boolean;
    readonly metaKey?: boolean;
}

export class Keyboard {
    private queue: KeyEvent[] = [];
    /** The key currently repeating, and how many frames it has been held. */
    private held: { event: KeyEvent; age: number } | null = null;
    private captured = false;

    /**
     * Told when capture is turned on or off, so the runtime can quiet the
     * joystick keymap: while the keyboard is being typed on, Z and X are
     * letters rather than triggers.
     */
    onCapture: ((capturing: boolean) => void) | null = null;

    /**
     * True while the machine is claiming the keyboard for text. Two things
     * follow: the joystick keymap goes quiet, and the host swallows the keys
     * the page would otherwise act on - space scrolling it, backspace going
     * back, tab moving focus. Keys held with ctrl, alt or the platform key are
     * never claimed, so the browser's own shortcuts survive being typed at.
     */
    get capturing(): boolean {
        return this.captured;
    }

    set capturing(on: boolean) {
        if (on === this.captured) return;
        this.captured = on;
        // A key held when the mode changed may never be seen coming up in the
        // mode that follows, so nothing carries across the boundary.
        this.held = null;
        this.onCapture?.(on);
    }

    // --- Reading ----------------------------------------------------------

    /**
     * Everything struck since this was last called, in the order it arrived,
     * and empties the queue. Anything left unread is dropped at the end of the
     * frame, so an app that ignores the keyboard does not accumulate one.
     */
    take(): readonly KeyEvent[] {
        if (this.queue.length === 0) return EMPTY;
        const events = this.queue;
        this.queue = [];
        return events;
    }

    /** How many events are waiting. Mostly for a readout. */
    get pending(): number {
        return this.queue.length;
    }

    /**
     * Whether the host should stop the page acting on this key itself. A host
     * asks; the answer is only ever yes while `capturing`.
     */
    claims(event: KeyLike): boolean {
        if (!this.captured) return false;
        if (event.ctrlKey || event.altKey || event.metaKey) return false;
        return event.key.length === 1 || CLAIMED.has(event.code);
    }

    // --- Writing, for hosts and tests --------------------------------------

    press(event: KeyLike): void {
        const struck: KeyEvent = {
            code: event.code,
            key: event.key,
            shift: !!event.shiftKey,
            ctrl: !!event.ctrlKey,
            alt: !!event.altKey,
            meta: !!event.metaKey,
            repeat: false
        };
        this.push(struck);
        // The newest key is the one that repeats, which is what a keyboard does.
        if (!MODIFIERS.has(struck.code)) this.held = { event: struck, age: 0 };
    }

    release(code: string): void {
        if (this.held?.event.code === code) this.held = null;
    }

    /** The window lost focus: nothing can be seen coming up any more. */
    releaseAll(): void {
        this.held = null;
    }

    /**
     * Types a string, one press and release per character. For tests and for
     * headless tools - a real host presses keys. The codes are plausible
     * rather than exact; it is `key` that carries the character.
     */
    type(text: string): void {
        for (const character of text) {
            const key = character === "\n" ? "Enter" : character;
            this.press({ code: codeFor(character), key, shiftKey: /[A-Z]/.test(character) });
            this.release(codeFor(character));
        }
    }

    /** Queues an event directly. Hosts with their own idea of a keystroke use this. */
    push(event: KeyEvent): void {
        this.queue.push(event);
        // A machine nobody is typing into must not grow a backlog to replay.
        if (this.queue.length > MAX_QUEUED) this.queue.splice(0, this.queue.length - MAX_QUEUED);
    }

    /**
     * Advances the repeat clock by one frame, queueing a repeat when one is
     * due. Called at the top of a frame so anything it makes is there to be
     * read by the update that follows.
     */
    tick(): void {
        const held = this.held;
        if (!held) return;

        ++held.age;
        if (held.age < REPEAT_DELAY) return;
        if ((held.age - REPEAT_DELAY) % REPEAT_INTERVAL !== 0) return;
        this.push({ ...held.event, repeat: true });
    }

    /**
     * Drops whatever was not read this frame. Called at the end of a frame,
     * where `Input.latch` and `Pointer.latch` are, and for the same reason:
     * one frame's worth of input is one frame's worth.
     */
    latch(): void {
        if (this.queue.length > 0) this.queue = [];
    }
}

const EMPTY: readonly KeyEvent[] = [];

/** A plausible `KeyboardEvent.code` for a character, for `type`. */
function codeFor(character: string): string {
    if (character >= "a" && character <= "z") return "Key" + character.toUpperCase();
    if (character >= "A" && character <= "Z") return "Key" + character;
    if (character >= "0" && character <= "9") return "Digit" + character;
    if (character === " ") return "Space";
    if (character === "\n") return "Enter";
    return "";
}
