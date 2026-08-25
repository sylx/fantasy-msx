// The mouse.
//
// An MSX read its mouse through a joystick port, two bits of relative movement
// at a time, and a program integrated the deltas itself - which is why MSX
// software that used one always felt like it was guessing. Nothing here does
// that. The host knows where the picture is on the page and at what scale, so
// it hands the machine a position already in screen pixels: the same
// coordinates `gfx` draws in, whatever size the canvas is on the page.
//
// The shape deliberately mirrors `Input`: state is latched once a frame, so
// `pressed` and `released` mean "since the last update" no matter how many
// events the browser delivered in between. The two will likely grow together
// once there is a third kind of event worth carrying.

/** Button numbers, as a browser reports them. */
export const MOUSE = {
    LEFT: 0,
    MIDDLE: 1,
    RIGHT: 2
} as const;

export type MouseButton = (typeof MOUSE)[keyof typeof MOUSE];

const BUTTON_COUNT = 3;

export class Pointer {
    private readonly current = new Uint8Array(BUTTON_COUNT);
    private readonly previous = new Uint8Array(BUTTON_COUNT);
    private position = { x: 0, y: 0 };
    private latched = { x: 0, y: 0 };
    private over = false;
    private ever = false;

    // --- Reading ----------------------------------------------------------

    /** Screen pixels. Outside the picture this keeps counting, and goes negative. */
    get x(): number {
        return this.position.x;
    }

    get y(): number {
        return this.position.y;
    }

    /** Movement since the previous frame. */
    get dx(): number {
        return this.position.x - this.latched.x;
    }

    get dy(): number {
        return this.position.y - this.latched.y;
    }

    /** True while the pointer is over the picture rather than beside it. */
    get inside(): boolean {
        return this.over;
    }

    /**
     * True once a pointer has reported at all. A machine on a touch screen may
     * never see one, and a cursor drawn for a device that has none is a lie.
     */
    get present(): boolean {
        return this.ever;
    }

    /** Held right now. */
    down(button: MouseButton = MOUSE.LEFT): boolean {
        return this.current[button] !== 0;
    }

    /** Went down between the previous frame and this one. */
    pressed(button: MouseButton = MOUSE.LEFT): boolean {
        return this.current[button] !== 0 && this.previous[button] === 0;
    }

    /** Came up between the previous frame and this one. */
    released(button: MouseButton = MOUSE.LEFT): boolean {
        return this.current[button] === 0 && this.previous[button] !== 0;
    }

    // --- Writing, for hosts and tests --------------------------------------

    /** `x` and `y` are screen pixels; `inside` says whether they landed on it. */
    setPosition(x: number, y: number, inside = true): void {
        this.position.x = x;
        this.position.y = y;
        this.over = inside;
        this.ever = true;
    }

    setButton(button: MouseButton, down: boolean): void {
        this.current[button] = down ? 1 : 0;
        this.ever = true;
    }

    /** The pointer left, or the window lost focus. Buttons cannot come back up. */
    releaseAll(): void {
        this.current.fill(0);
        this.over = false;
    }

    /**
     * Records the current state as the baseline the next frame compares
     * against, and resets the movement. Called at the end of a frame for the
     * same reason `Input.latch` is: an event that arrives between two frames
     * has to still read as new when the next update looks at it.
     */
    latch(): void {
        this.previous.set(this.current);
        this.latched.x = this.position.x;
        this.latched.y = this.position.y;
    }
}
