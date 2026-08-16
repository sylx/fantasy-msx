// The browser host: a canvas to show frames on, a keyboard and gamepads to
// read, and a clock pinned to 60Hz regardless of what the display runs at.

import type { Frame } from "../core/machine.js";
import { BUTTON, type Button, type Input, type Player } from "../runtime/input.js";
import { FRAME_RATE, type Host, type Runtime } from "../runtime/runtime.js";
import { WebAudioOutput } from "./audio.js";

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
}

/** Gamepad button indices, in the standard mapping, for the two triggers. */
const GAMEPAD_A = 0;
const GAMEPAD_B = 1;
const AXIS_THRESHOLD = 0.4;

export class BrowserHost implements Host {
    private readonly canvas: HTMLCanvasElement;
    private readonly context: CanvasRenderingContext2D;
    private readonly options: BrowserHostOptions;
    private input: Input | null = null;
    private audio: WebAudioOutput | null = null;
    private raf = 0;
    private previousTime = 0;
    private accumulator = 0;
    private readonly listeners: Array<() => void> = [];

    constructor(options: BrowserHostOptions) {
        this.options = options;
        this.canvas = options.canvas;
        const context = this.canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("could not get a 2d context for the display canvas");
        this.context = context;
        // Nearest neighbour: the pixels are the point.
        this.context.imageSmoothingEnabled = false;
    }

    attach(runtime: Runtime): void {
        const input = runtime.input;
        this.input = input;

        if (this.options.audio !== false) {
            this.audio = new WebAudioOutput(runtime.bios.system.machine);
            void this.audio.start();
        }

        const onKey = (event: KeyboardEvent, down: boolean) => {
            if (event.repeat) return;
            // Browsers keep audio suspended until the user does something.
            if (down) void this.audio?.resume();
            // Swallow only the keys the machine claims, so browser shortcuts survive.
            if (input.setKey(event.code, down)) event.preventDefault();
        };
        const keyDown = (event: KeyboardEvent) => onKey(event, true);
        const keyUp = (event: KeyboardEvent) => onKey(event, false);
        const blur = () => {
            input.releaseAll();
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
    }

    present(frame: Frame | null): void {
        const { width, height } = this.canvas;
        this.context.fillStyle = this.options.background ?? "#000";
        this.context.fillRect(0, 0, width, height);
        if (!frame) return;

        const scale = this.options.scale
            ?? Math.max(1, Math.floor(Math.min(width / frame.width, height / frame.height)));
        const drawWidth = frame.width * scale;
        const drawHeight = frame.height * scale;

        this.context.drawImage(
            // In a browser the VDP renders into a real canvas, which is what this is.
            frame.source as unknown as CanvasImageSource,
            0, 0, frame.width, frame.height,
            ((width - drawWidth) / 2) | 0, ((height - drawHeight) / 2) | 0,
            drawWidth, drawHeight
        );
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
        void this.audio?.stop();
        this.audio = null;
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
