// Input.
//
// An MSX joystick has four directions and two triggers, and the machine has
// two ports. That is the whole controller, and it is what games are written
// against here. Anything else - pause, menus, text entry - comes from the
// keyboard, which is exposed raw.
//
// State is latched once per frame, so `pressed` and `released` mean "since the
// last update", not "since the browser last fired an event".

export const BUTTON = {
    UP: 0,
    DOWN: 1,
    LEFT: 2,
    RIGHT: 3,
    /** The MSX joystick's trigger 1. */
    A: 4,
    /** Trigger 2. */
    B: 5
} as const;

export type Button = (typeof BUTTON)[keyof typeof BUTTON];
export type Player = 0 | 1;

const BUTTON_COUNT = 6;
const PLAYERS = 2;

/** Which keys stand in for each player's joystick when there is no gamepad. */
export const DEFAULT_KEY_MAP: ReadonlyArray<Readonly<Record<string, Button>>> = [
    { ArrowUp: BUTTON.UP, ArrowDown: BUTTON.DOWN, ArrowLeft: BUTTON.LEFT, ArrowRight: BUTTON.RIGHT, KeyZ: BUTTON.A, KeyX: BUTTON.B },
    { KeyW: BUTTON.UP, KeyS: BUTTON.DOWN, KeyA: BUTTON.LEFT, KeyD: BUTTON.RIGHT, KeyN: BUTTON.A, KeyM: BUTTON.B }
];

export class Input {
    private readonly current = new Uint8Array(PLAYERS * BUTTON_COUNT);
    private readonly previous = new Uint8Array(PLAYERS * BUTTON_COUNT);
    private readonly keysDown = new Set<string>();
    private readonly keysWere = new Set<string>();
    private keyMap: ReadonlyArray<Readonly<Record<string, Button>>> = DEFAULT_KEY_MAP;
    private typingNow = false;

    /** Replaces the keyboard bindings. One record per player. */
    setKeyMap(map: ReadonlyArray<Readonly<Record<string, Button>>>): void {
        this.keyMap = map;
    }

    /**
     * True while the keyboard is being typed on rather than played, which the
     * runtime sets from `Keyboard.capturing`. The keymap goes quiet - Z and X
     * are letters again - and raw keys go on being recorded, since `key()` is
     * about which keys are down and that does not change with the use they are
     * being put to.
     */
    get typing(): boolean {
        return this.typingNow;
    }

    setTyping(on: boolean): void {
        if (on === this.typingNow) return;
        this.typingNow = on;
        // A key holding a button down may never be seen coming up now that the
        // keymap has stopped listening, so nothing stays held across the change.
        if (on) this.current.fill(0);
    }

    // --- Reading ----------------------------------------------------------

    /** Held right now. */
    btn(button: Button, player: Player = 0): boolean {
        return this.current[player * BUTTON_COUNT + button] !== 0;
    }

    /** Went down between the previous frame and this one. */
    btnp(button: Button, player: Player = 0): boolean {
        const i = player * BUTTON_COUNT + button;
        return this.current[i] !== 0 && this.previous[i] === 0;
    }

    /** Came up between the previous frame and this one. */
    btnr(button: Button, player: Player = 0): boolean {
        const i = player * BUTTON_COUNT + button;
        return this.current[i] === 0 && this.previous[i] !== 0;
    }

    /** -1, 0 or 1 along each axis, which is usually all a game wants. */
    axis(player: Player = 0): { x: number; y: number } {
        return {
            x: (this.btn(BUTTON.RIGHT, player) ? 1 : 0) - (this.btn(BUTTON.LEFT, player) ? 1 : 0),
            y: (this.btn(BUTTON.DOWN, player) ? 1 : 0) - (this.btn(BUTTON.UP, player) ? 1 : 0)
        };
    }

    /** Raw key, by KeyboardEvent.code - "Escape", "Space", "KeyQ". */
    key(code: string): boolean {
        return this.keysDown.has(code);
    }

    keyp(code: string): boolean {
        return this.keysDown.has(code) && !this.keysWere.has(code);
    }

    keyr(code: string): boolean {
        return !this.keysDown.has(code) && this.keysWere.has(code);
    }

    // --- Writing, for hosts and tests --------------------------------------

    setButton(button: Button, down: boolean, player: Player = 0): void {
        this.current[player * BUTTON_COUNT + button] = down ? 1 : 0;
    }

    /**
     * Records a raw key and, if it is bound, the joystick button it stands for.
     * Returns true when the key was bound, which is a host's cue to swallow it.
     */
    setKey(code: string, down: boolean): boolean {
        if (down) this.keysDown.add(code);
        else this.keysDown.delete(code);
        if (this.typingNow) return false;

        let bound = false;
        for (let player = 0; player < this.keyMap.length; ++player) {
            const button = this.keyMap[player][code];
            if (button !== undefined) {
                this.setButton(button, down, player as Player);
                bound = true;
            }
        }
        return bound;
    }

    /** Forgets everything held. Hosts call this when the window loses focus. */
    releaseAll(): void {
        this.current.fill(0);
        this.keysDown.clear();
    }

    /**
     * Records the current state as the baseline the next frame compares
     * against. Called at the end of a frame, not the start: events arrive
     * between frames, and a key pressed in that gap has to still read as new
     * when the next update runs.
     */
    latch(): void {
        this.previous.set(this.current);
        this.keysWere.clear();
        for (const code of this.keysDown) this.keysWere.add(code);
    }
}
