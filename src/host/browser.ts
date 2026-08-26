// The browser host: a canvas to show frames on, a keyboard and gamepads to
// read, and a clock pinned to 60Hz regardless of what the display runs at.

import type { Frame } from "../core/machine.js";
import { BUTTON, type Button, type Input, type Player } from "../runtime/input.js";
import { MOUSE, type MouseButton, type Pointer } from "../runtime/pointer.js";
import { FRAME_RATE, type DroppedFile, type Host, type Runtime } from "../runtime/runtime.js";
import { WebAudioOutput } from "./audio.js";
import { CrtDisplay, type CrtOptions } from "./crt.js";

const FRAME_SECONDS = 1 / FRAME_RATE;
/** Never run more than this many frames to catch up, or a stall turns into a stampede. */
const MAX_CATCH_UP = 3;

export interface BrowserHostOptions {
    /** Where to draw. */
    canvas: HTMLCanvasElement;
    /** Integer pixel scale. Omit to fit the canvas and pick the largest that does. */
    scale?: number;
    /** Colour behind the picture when it does not fill the canvas. */
    background?: string;
    /** Read gamepads as well as the keyboard. On by default. */
    gamepads?: boolean;
    /** Open the sound device. On by default. */
    audio?: boolean;
    /** Accept files dropped on the screen. On by default. */
    drop?: boolean;
    /** Report the mouse. On by default. */
    pointer?: boolean;
    /**
     * Put the picture through the CRT shader: `true` for its defaults, or the
     * parameters to start with. Off by default, and off means the canvas keeps
     * its 2D context and none of this is compiled.
     *
     * A canvas has one kind of context for its lifetime, so this decides which
     * one it gets. Where WebGL2 is not available the host says so and falls
     * back to drawing the frame itself, and `host.crt` is then null.
     */
    crt?: boolean | CrtOptions;
}

/**
 * Where the picture landed on the canvas last frame, which is what turns a
 * browser's client coordinates back into the machine's own pixels.
 */
interface Layout {
    scale: number;
    /** Top-left of the drawn picture, in canvas pixels. */
    x: number;
    y: number;
    /** Width of one screen pixel against its height. */
    aspect: number;
    /** The border the VDP draws around the active display, in screen pixels. */
    borderX: number;
    borderY: number;
    /** The active display: the coordinates the machine itself draws in. */
    width: number;
    height: number;
}

/** Wraps a browser File as the machine sees it. */
function describe(file: File): DroppedFile {
    return {
        name: file.name,
        type: file.type,
        size: file.size,
        url: URL.createObjectURL(file),
        bytes: async () => new Uint8Array(await file.arrayBuffer()),
        text: () => file.text()
    };
}

/** Gamepad button indices, in the standard mapping, for the two triggers. */
const GAMEPAD_A = 0;
const GAMEPAD_B = 1;
const AXIS_THRESHOLD = 0.4;

export class BrowserHost implements Host {
    /** The tube the picture arrives on, or null where it is going straight to the canvas. */
    readonly crt: CrtDisplay | null = null;

    private readonly canvas: HTMLCanvasElement;
    /** Null when the CRT owns the canvas: a canvas only ever has one context. */
    private readonly context: CanvasRenderingContext2D | null = null;
    private readonly options: BrowserHostOptions;
    private input: Input | null = null;
    private audio: WebAudioOutput | null = null;
    private runtime: Runtime | null = null;
    /** Null until a frame has been shown and there is somewhere to point at. */
    /** Where a 512-wide mode is squashed, when the canvas has no whole number to give. */
    private scratch: HTMLCanvasElement | null = null;
    private layout: Layout | null = null;
    private raf = 0;
    private previousTime = 0;
    private accumulator = 0;
    private readonly listeners: Array<() => void> = [];

    constructor(options: BrowserHostOptions) {
        this.options = options;
        this.canvas = options.canvas;

        if (options.crt) {
            this.crt = CrtDisplay.create(this.canvas, options.crt === true ? {} : options.crt);
            if (this.crt) return;
        }

        const context = this.canvas.getContext("2d", { alpha: false });
        if (!context) {
            throw new Error("could not get a 2d context for the display canvas"
                + " (a canvas that has already been given a WebGL context cannot give one)");
        }
        this.context = context;
        // Nearest neighbour: the pixels are the point.
        this.context.imageSmoothingEnabled = false;
    }

    attach(runtime: Runtime): void {
        const input = runtime.input;
        this.input = input;
        this.runtime = runtime;

        if (this.options.audio !== false) {
            this.audio = new WebAudioOutput(runtime.bios.system.machine);
            void this.audio.start();
        }

        const keyboard = runtime.keyboard;
        const onKey = (event: KeyboardEvent, down: boolean) => {
            // The browser's own repeats are dropped: the runtime makes its own,
            // so a headless run and this one see the same keystrokes.
            if (event.repeat) return;
            // Browsers keep audio suspended until the user does something.
            if (down) void this.audio?.resume();

            if (down) keyboard.press(event);
            else keyboard.release(event.code);

            // Swallow only the keys the machine claims, so browser shortcuts
            // survive - the joystick's, and while text is being typed the keys
            // the page would otherwise scroll or navigate with.
            const bound = input.setKey(event.code, down);
            if (bound || keyboard.claims(event)) event.preventDefault();
        };
        const keyDown = (event: KeyboardEvent) => onKey(event, true);
        const keyUp = (event: KeyboardEvent) => onKey(event, false);
        const blur = () => {
            input.releaseAll();
            keyboard.releaseAll();
            runtime.pointer.releaseAll();
            this.audio?.flush();
        };
        const gesture = () => void this.audio?.resume();

        window.addEventListener("keydown", keyDown);
        window.addEventListener("keyup", keyUp);
        window.addEventListener("blur", blur);
        window.addEventListener("pointerdown", gesture);
        this.listeners.push(() => {
            window.removeEventListener("keydown", keyDown);
            window.removeEventListener("keyup", keyUp);
            window.removeEventListener("blur", blur);
            window.removeEventListener("pointerdown", gesture);
        });

        if (this.options.drop !== false) this.bindDrop(runtime);
        if (this.options.pointer !== false) this.bindPointer(runtime.pointer);
    }

    /**
     * Files dropped on the screen.
     *
     * The window listeners are there to stop a drop that misses: without them
     * the browser navigates away to the file, which loses whatever was running.
     * Only the canvas actually delivers anything, and while something is over
     * it the canvas carries `data-drop="over"` for a page that wants to say so.
     */
    private bindDrop(runtime: Runtime): void {
        const canvas = this.canvas;

        // Everywhere but the screen: refuse the file, but refuse it ourselves
        // rather than letting the browser navigate away to it.
        const swallow = (event: DragEvent) => {
            if (event.target === canvas) return;
            if (!event.dataTransfer?.types.includes("Files")) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "none";
        };

        const over = (event: DragEvent) => {
            if (!event.dataTransfer?.types.includes("Files")) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            canvas.dataset.drop = "over";
        };
        const leave = () => { delete canvas.dataset.drop; };

        const drop = (event: DragEvent) => {
            leave();
            if (!event.dataTransfer?.types.includes("Files")) return;
            event.preventDefault();

            const dropped = Array.from<File>(event.dataTransfer.files);
            if (dropped.length === 0) return;
            // A drop is a gesture, and the browser will let the sound out now.
            void this.audio?.resume();

            const files = dropped.map(describe);
            // The object URLs stay readable exactly as long as the app is
            // using them, and an app that drops the ball must not go unheard.
            void runtime.drop(files)
                .catch((error: unknown) => console.error("drop handler failed:", error))
                .finally(() => {
                    for (const file of files) URL.revokeObjectURL(file.url);
                });
        };

        window.addEventListener("dragover", swallow);
        window.addEventListener("drop", swallow);
        canvas.addEventListener("dragover", over);
        canvas.addEventListener("dragleave", leave);
        canvas.addEventListener("drop", drop);
        this.listeners.push(() => {
            window.removeEventListener("dragover", swallow);
            window.removeEventListener("drop", swallow);
            canvas.removeEventListener("dragover", over);
            canvas.removeEventListener("dragleave", leave);
            canvas.removeEventListener("drop", drop);
            leave();
        });
    }

    /**
     * The mouse, in the machine's own pixels.
     *
     * Two transforms sit between a browser's client coordinates and a screen
     * pixel: the page scales the canvas with CSS, and `present` scales the
     * picture to fit inside it. `toScreen` undoes both, and then the VDP's
     * border, so an app hit-tests in the coordinates it drew in.
     *
     * Pointer events rather than mouse events, so a finger works too, and a
     * press captures the pointer: a fader being dragged goes on following the
     * mouse after it has left the screen, which a plain `mouseup` on the canvas
     * would not give.
     */
    private bindPointer(pointer: Pointer): void {
        const canvas = this.canvas;

        const move = (event: PointerEvent) => {
            const point = this.toScreen(event);
            if (point) pointer.setPosition(point.x, point.y, point.inside);
        };

        const down = (event: PointerEvent) => {
            if (event.button > MOUSE.RIGHT) return;
            move(event);
            pointer.setButton(event.button as MouseButton, true);
            canvas.setPointerCapture?.(event.pointerId);
            // Keeps a finger dragging a fader from scrolling the page with it.
            event.preventDefault();
        };

        const up = (event: PointerEvent) => {
            if (event.button > MOUSE.RIGHT) return;
            move(event);
            pointer.setButton(event.button as MouseButton, false);
            canvas.releasePointerCapture?.(event.pointerId);
        };

        // Buttons cannot be seen coming up once the pointer is gone, so a
        // cancelled or departed pointer lets go of everything it was holding.
        const cancel = () => pointer.releaseAll();
        const leave = () => pointer.setPosition(pointer.x, pointer.y, false);

        canvas.addEventListener("pointermove", move);
        canvas.addEventListener("pointerdown", down);
        canvas.addEventListener("pointerup", up);
        canvas.addEventListener("pointercancel", cancel);
        canvas.addEventListener("pointerleave", leave);
        this.listeners.push(() => {
            canvas.removeEventListener("pointermove", move);
            canvas.removeEventListener("pointerdown", down);
            canvas.removeEventListener("pointerup", up);
            canvas.removeEventListener("pointercancel", cancel);
            canvas.removeEventListener("pointerleave", leave);
            pointer.releaseAll();
        });
    }

    /** Client coordinates to screen pixels. Null until a frame has been shown. */
    private toScreen(event: { clientX: number; clientY: number }): { x: number; y: number; inside: boolean } | null {
        const layout = this.layout;
        if (!layout) return null;

        // A canvas has its own pixel grid and a CSS size that need not match.
        const rect = this.canvas.getBoundingClientRect?.();
        const across = rect && rect.width > 0 ? this.canvas.width / rect.width : 1;
        const down = rect && rect.height > 0 ? this.canvas.height / rect.height : 1;
        const canvasX = (event.clientX - (rect?.left ?? 0)) * across;
        const canvasY = (event.clientY - (rect?.top ?? 0)) * down;

        // Out of the letterbox, then out of the border the VDP draws around
        // the active display - which the machine never draws on.
        const x = Math.floor((canvasX - layout.x) / (layout.scale * layout.aspect)) - layout.borderX;
        const y = Math.floor((canvasY - layout.y) / layout.scale) - layout.borderY;
        return { x, y, inside: x >= 0 && y >= 0 && x < layout.width && y < layout.height };
    }

    present(frame: Frame | null, pixelAspect = 1): void {
        const { width, height } = this.canvas;
        const background = this.options.background ?? "#000";

        if (!frame) {
            if (this.crt) this.crt.clear(background);
            else if (this.context) {
                this.context.fillStyle = background;
                this.context.fillRect(0, 0, width, height);
            }
            return;
        }

        // Scale by the picture's true width, not its pixel count: a 512-pixel
        // mode fills the same screen as a 256-pixel one, so both come out the
        // same size and neither is stretched.
        const trueWidth = frame.width * pixelAspect;
        const scale = this.options.scale
            ?? Math.max(1, Math.floor(Math.min(width / trueWidth, height / frame.height)));
        const drawWidth = Math.round(trueWidth * scale);
        const drawHeight = frame.height * scale;
        const left = ((width - drawWidth) / 2) | 0;
        const top = ((height - drawHeight) / 2) | 0;

        // In a browser the VDP renders into a real canvas, which is what this is.
        const source = frame.source as unknown as CanvasImageSource;
        if (this.crt) {
            // The VDP renders into one canvas of a fixed size whatever the
            // mode and puts the picture in a corner of it, so what goes up is
            // the whole image and the crop says which part of it to show. The
            // GPU does the magnification from there, and the resolving of odd
            // columns below happens in the shader instead.
            this.crt.present(
                {
                    image: source as TexImageSource,
                    // A source that will not say how large it is is taken to be
                    // the picture and nothing else, which is the old behaviour.
                    width: frame.source.width || frame.width,
                    height: frame.source.height || frame.height,
                    crop: { x: 0, y: 0, width: frame.width, height: frame.height }
                },
                { x: left, y: top, width: drawWidth, height: drawHeight }, background
            );
        } else if (this.context) {
            this.context.fillStyle = background;
            this.context.fillRect(0, 0, width, height);

            const columns = this.resolve(source, frame, drawWidth, drawHeight);
            if (columns) {
                // The extra columns are resolved rather than picked: smoothing is on
                // for this one draw, and only the horizontal is being changed.
                this.context.imageSmoothingEnabled = true;
                this.context.imageSmoothingQuality = "high";
                this.context.drawImage(columns, 0, 0, frame.width, drawHeight, left, top, drawWidth, drawHeight);
                this.context.imageSmoothingEnabled = false;
            } else {
                this.context.drawImage(source, 0, 0, frame.width, frame.height, left, top, drawWidth, drawHeight);
            }
        }

        // Where it landed, so the mouse can be read back into the same pixels.
        // The frame carries the border with it and the active display sits in
        // the middle of it, which is where the machine's own origin is.
        //
        // The CRT's curvature is not undone here: it bends what is shown, not
        // where the machine thinks its pixels are, so a heavily curved tube
        // and the cursor drift apart at the corners.
        const screen = this.runtime?.bios.screen;
        const active = { width: screen?.width ?? frame.width, height: screen?.height ?? frame.height };
        this.layout = {
            scale, x: left, y: top, aspect: pixelAspect,
            borderX: (frame.width - active.width) >> 1,
            borderY: (frame.height - active.height) >> 1,
            width: active.width,
            height: active.height
        };
    }

    /**
     * The frame at one canvas pixel per pixel across, for the case where a
     * whole number of them will not fit - or null where the picture goes
     * straight to the screen, which is every square-pixel mode.
     *
     * **What this is for.** A 512-wide mode has twice as many columns as the
     * screen is wide, so its pixels are drawn half as wide, and a canvas sized
     * for the 256-wide modes has an odd number of them to give: 816 pixels
     * across a 544-pixel frame is one and a half each. `imageSmoothingEnabled`
     * is off everywhere else here, and nearest neighbour at one and a half
     * keeps every other column twice - so the same stroke comes out two pixels
     * wide in one place and three in the next. Measured over a page of
     * 12-pixel type: runs of solid ink 1, 2 and 3 pixels long in roughly equal
     * numbers, for a face whose stems are all the same width. That is what a
     * 512-wide screen of small type looks bold and ragged for, and it is the
     * presentation doing it - the pixels underneath are exact.
     *
     * So the vertical, which is a whole number, is done first and nearest, and
     * the horizontal is left to a filter. Which is also what the mode is:
     * columns finer than the display can resolve, resolved rather than chosen.
     * Where the magnification does divide - every square-pixel mode, and a
     * 512-wide one on a canvas sized for it - none of this happens.
     */
    private resolve(source: CanvasImageSource, frame: Frame, drawWidth: number, drawHeight: number): HTMLCanvasElement | null {
        if (drawWidth % frame.width === 0) return null;
        if (typeof document === "undefined" || typeof document.createElement !== "function") return null;

        const scratch = this.scratch ?? (this.scratch = document.createElement("canvas"));
        if (scratch.width !== frame.width || scratch.height !== drawHeight) {
            scratch.width = frame.width;
            scratch.height = drawHeight;
        }
        const context = scratch.getContext("2d");
        if (!context) return null;

        context.imageSmoothingEnabled = false;
        context.drawImage(source, 0, 0, frame.width, frame.height, 0, 0, frame.width, drawHeight);
        return scratch;
    }

    start(tick: () => void): void {
        this.previousTime = performance.now() / 1000;
        this.accumulator = 0;

        const loop = (now: number) => {
            this.raf = requestAnimationFrame(loop);

            const seconds = now / 1000;
            this.accumulator += Math.min(seconds - this.previousTime, MAX_CATCH_UP * FRAME_SECONDS);
            this.previousTime = seconds;

            // A fixed 60Hz step, whatever the display's refresh rate is.
            while (this.accumulator >= FRAME_SECONDS) {
                this.accumulator -= FRAME_SECONDS;
                this.pollGamepads();
                tick();
                // One frame of samples for one frame of machine time.
                this.audio?.push();
            }
        };
        this.raf = requestAnimationFrame(loop);
    }

    stop(): void {
        cancelAnimationFrame(this.raf);
        this.raf = 0;
        for (const remove of this.listeners) remove();
        this.listeners.length = 0;
        this.layout = null;
        void this.audio?.stop();
        this.audio = null;
        // The context stays on the canvas - it has to, a canvas cannot swap
        // one - but the program and the texture on it are this host's.
        this.crt?.dispose();
    }

    private pollGamepads(): void {
        if (!this.input || this.options.gamepads === false || !navigator.getGamepads) return;

        const pads = navigator.getGamepads();
        for (let player = 0; player < 2; ++player) {
            const pad = pads[player];
            if (!pad) continue;

            const held = (button: Button, down: boolean) => this.input!.setButton(button, down, player as Player);
            const x = pad.axes[0] ?? 0;
            const y = pad.axes[1] ?? 0;
            // A d-pad reports as buttons 12-15 in the standard mapping; accept either.
            held(BUTTON.LEFT, x < -AXIS_THRESHOLD || !!pad.buttons[14]?.pressed);
            held(BUTTON.RIGHT, x > AXIS_THRESHOLD || !!pad.buttons[15]?.pressed);
            held(BUTTON.UP, y < -AXIS_THRESHOLD || !!pad.buttons[12]?.pressed);
            held(BUTTON.DOWN, y > AXIS_THRESHOLD || !!pad.buttons[13]?.pressed);
            held(BUTTON.A, !!pad.buttons[GAMEPAD_A]?.pressed);
            held(BUTTON.B, !!pad.buttons[GAMEPAD_B]?.pressed);
        }
    }
}
