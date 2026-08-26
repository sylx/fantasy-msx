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
import type { Console, Graphics, Images, Ime, Screen, SoundDriver, Sprites, Typesetter } from "../bios/index.js";
import type { Frame } from "../core/machine.js";
import type { Crt } from "../host/crt.js";
import { Input } from "./input.js";
import { Keyboard } from "./keyboard.js";
import { Pointer } from "./pointer.js";

/** What the game is handed every frame. */
export interface Context {
    readonly bios: Bios;
    readonly screen: Screen;
    readonly gfx: Graphics;
    readonly sprites: Sprites;
    /** Loading pictures from URLs, reduced to what the screen mode can show. */
    readonly image: Images;
    /** Text in the host's own fonts, rasterised outside the machine and carried in. */
    readonly text: Typesetter;
    /** A character grid over the bitmap, repainted a changed cell at a time. */
    readonly console: Console;
    /**
     * Japanese input: keystrokes in, a preedit and candidates out, drawn by the
     * machine rather than by the browser. Inert until an engine is attached.
     */
    readonly ime: Ime;
    /** Music and effects. Already ticking on the vertical interrupt. */
    readonly bgm: SoundDriver;
    readonly input: Input;
    /**
     * Keys as things to type on rather than to play: a queue of keystrokes in
     * the order they arrived, drained once a frame. `capturing` is how an app
     * says it wants them.
     */
    readonly keyboard: Keyboard;
    /**
     * The mouse, in screen pixels. Hosts that have no pointing device simply
     * never move it, and `pointer.present` says which case you are in.
     */
    readonly pointer: Pointer;
    /**
     * The CRT the picture is arriving on, and its parameters - null where the
     * host is putting frames straight on a canvas, which is the default.
     *
     *     ctx.crt?.set({ curvature: 0.2, scanlineIntensity: 0.5 });
     */
    readonly crt: Crt | null;
    /** Frames since the runtime started. */
    readonly frame: number;
    /** Seconds since the runtime started, counted in frames rather than wall clock. */
    readonly time: number;
}

/**
 * A file handed to the machine from outside it - dropped on the screen, in the
 * browser host's case.
 *
 * `url` is the cheap way in: it is what `image.load` and anything else taking
 * a URL wants. It is only valid while the handler is running, though - the
 * host releases it as soon as the handler settles, so a handler that means to
 * keep the file must return the promise that reads it.
 */
export interface DroppedFile {
    readonly name: string;
    /** MIME type as the host reported it. Empty when it could not tell. */
    readonly type: string;
    readonly size: number;
    /** Valid until the drop handler settles. */
    readonly url: string;
    bytes(): Promise<Uint8Array>;
    text(): Promise<string>;
}

export interface App {
    /** Run once, before the first frame. Set the mode and boot screen here. */
    init?(ctx: Context): void;
    /** Game logic. Free - nothing here costs the machine anything. */
    update(ctx: Context): void;
    /** Queues drawing. What it queues may take several frames to appear. */
    draw?(ctx: Context): void;
    /**
     * Files dropped on the screen. Return a promise if the files are read
     * asynchronously: the host keeps them readable until it settles.
     */
    drop?(ctx: Context, files: readonly DroppedFile[]): void | Promise<void>;
}

/** Where frames go and what drives the clock. */
export interface Host {
    /**
     * The CRT this host shows frames through, where it has one. A host with no
     * such thing simply has not got the property, and `runtime.crt` is null.
     */
    readonly crt?: Crt | null;
    /**
     * Called once, with the runtime, so the host can reach the things it needs
     * - input to wire events to, and the machine to pull audio from.
     */
    attach?(runtime: Runtime): void;
    /**
     * Shows a finished frame. `pixelAspect` is the width of one of its pixels
     * against its height, relative to the 256-pixel modes: 1 for those, and
     * 0.5 for the 512-pixel ones, whose pixels are tall.
     */
    present(frame: Frame | null, pixelAspect: number): void;
    /** Begins calling `tick` at 60Hz. */
    start(tick: () => void): void;
    stop(): void;
}

export const FRAME_RATE = 60;

export class Runtime implements Context {
    readonly input = new Input();
    readonly pointer = new Pointer();
    readonly keyboard = new Keyboard();
    private app: App | null = null;
    private frameCount = 0;
    private running = false;

    constructor(readonly bios: Bios, private readonly host: Host) {
        // Typing and playing are two uses of one keyboard: while it is being
        // typed on, the joystick keymap has to stop reading Z and X as triggers.
        this.keyboard.onCapture = (capturing) => this.input.setTyping(capturing);
        this.host.attach?.(this);
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

    get image(): Images {
        return this.bios.image;
    }

    get text(): Typesetter {
        return this.bios.text;
    }

    get console(): Console {
        return this.bios.console;
    }

    get ime(): Ime {
        return this.bios.ime;
    }

    get bgm(): SoundDriver {
        return this.bios.bgm;
    }

    get crt(): Crt | null {
        return this.host.crt ?? null;
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
     * Hands the app files from outside the machine. Hosts call this; so can a
     * test, with files of its own making.
     *
     * The returned promise settles when the app has finished with them, which
     * is a host's cue that it may stop keeping them readable.
     */
    async drop(files: readonly DroppedFile[]): Promise<void> {
        if (files.length > 0) await this.app?.drop?.(this, files);
    }

    /**
     * Advances a fixed number of frames without a host driving the clock.
     * Tests and screenshot tools use this; a running game does not.
     */
    step(frames = 1): void {
        for (let i = 0; i < frames; ++i) this.tick();
    }

    private tick(): void {
        // Repeats are made before the app looks, so a held key reads as a fresh
        // keystroke in the frame it is due rather than the one after.
        this.keyboard.tick();
        this.app?.update(this);
        this.app?.draw?.(this);

        this.bios.screen.frame();
        ++this.frameCount;

        this.host.present(this.bios.system.machine.getFrame(), this.screen.pixelAspect);
        // Latch last: anything the host delivered between frames must still
        // read as newly pressed when the next update looks at it.
        this.input.latch();
        this.pointer.latch();
        this.keyboard.latch();
    }
}
