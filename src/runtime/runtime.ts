// The frame loop.
//
// One tick is one 60Hz frame: latch input, run the game, let the machine draw
// 262 scanlines, hand the result to the host. `update` and `draw` are separate
// for the usual reason - a host that needs to catch up can run several updates
// against one draw - but note what `draw` means here.
//
// It does not repaint the screen. The framebuffer is persistent, the way it is
// on an MSX, and the blitter is still working through what earlier frames
// queued. `draw` adds to that queue. Moving things belong in sprites, which
// the VDP composites every scanline for nothing.

import type { Bios } from "../bios/index.js";
import type { Graphics, Screen, Sprites } from "../bios/index.js";
import type { Frame } from "../core/machine.js";
import { Input } from "./input.js";

/** What the game is handed every frame. */
export interface Context {
    readonly bios: Bios;
    readonly screen: Screen;
    readonly gfx: Graphics;
    readonly sprites: Sprites;
    readonly input: Input;
    /** Frames since the runtime started. */
    readonly frame: number;
    /** Seconds since the runtime started, counted in frames rather than wall clock. */
    readonly time: number;
}

export interface App {
    /** Run once, before the first frame. Set the mode and boot screen here. */
    init?(ctx: Context): void;
    /** Game logic. Free - nothing here costs the machine anything. */
    update(ctx: Context): void;
    /** Queues drawing. What it queues may take several frames to appear. */
    draw?(ctx: Context): void;
}

/** Where frames go and what drives the clock. */
export interface Host {
    /** Wires up event sources - keyboard, gamepads - to the runtime's input. */
    attach?(input: Input): void;
    /** Shows a finished frame. */
    present(frame: Frame | null): void;
    /** Begins calling `tick` at 60Hz. */
    start(tick: () => void): void;
    stop(): void;
}

export const FRAME_RATE = 60;

export class Runtime implements Context {
    readonly input = new Input();
    private app: App | null = null;
    private frameCount = 0;
    private running = false;

    constructor(readonly bios: Bios, private readonly host: Host) {
        this.host.attach?.(this.input);
    }

    get screen(): Screen {
        return this.bios.screen;
    }

    get gfx(): Graphics {
        return this.bios.gfx;
    }

    get sprites(): Sprites {
        return this.bios.sprites;
    }

    get frame(): number {
        return this.frameCount;
    }

    get time(): number {
        return this.frameCount / FRAME_RATE;
    }

    /** Runs `app` until `stop()`. */
    run(app: App): void {
        this.app = app;
        this.running = true;
        app.init?.(this);
        this.host.start(() => this.tick());
    }

    stop(): void {
        this.running = false;
        this.host.stop();
    }

    get isRunning(): boolean {
        return this.running;
    }

    /**
     * Advances a fixed number of frames without a host driving the clock.
     * Tests and screenshot tools use this; a running game does not.
     */
    step(frames = 1): void {
        for (let i = 0; i < frames; ++i) this.tick();
    }

    private tick(): void {
        this.app?.update(this);
        this.app?.draw?.(this);

        this.bios.screen.frame();
        ++this.frameCount;

        this.host.present(this.bios.system.machine.getFrame());
        // Latch last: anything the host delivered between frames must still
        // read as newly pressed when the next update looks at it.
        this.input.latch();
    }
}
