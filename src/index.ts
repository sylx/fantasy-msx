// Fantasy MSX.
//
//     import { run, BUTTON } from "fantasy-msx";
//
//     run({
//         init({ gfx })   { gfx.now.clear(1); },
//         update({ input, sprites }) { ... },
//         draw({ gfx })   { ... }
//     }, { canvas: document.querySelector("canvas") });

import { createBios, type Bios } from "./bios/index.js";
import { BrowserHost } from "./host/browser.js";
import { HeadlessHost } from "./host/headless.js";
import { Runtime, type App, type Host } from "./runtime/runtime.js";

export { createSystem, type System } from "./api/index.js";
export * from "./api/v9938.js";
export { Opll, Psg, Vdp, VdpCommands } from "./api/index.js";
export * from "./bios/index.js";
export { BrowserHost, type BrowserHostOptions } from "./host/browser.js";
export { HeadlessHost } from "./host/headless.js";
export * from "./runtime/input.js";
export { Runtime, FRAME_RATE, type App, type Context, type Host } from "./runtime/runtime.js";

export interface BootOptions {
    /** Where to show the picture. Without one the machine runs headless. */
    canvas?: HTMLCanvasElement;
    /** Integer pixel scale. Omit to fill the canvas. */
    scale?: number;
    /** A host of your own, instead of the two built in. */
    host?: Host;
    /** An already-built machine, for sharing one between tools. */
    bios?: Bios;
}

/** Brings up a machine and a runtime, without starting the clock. */
export function boot(options: BootOptions = {}): Runtime {
    const host = options.host
        ?? (options.canvas
            ? new BrowserHost({ canvas: options.canvas, scale: options.scale })
            : new HeadlessHost());

    return new Runtime(options.bios ?? createBios(), host);
}

/** Brings up a machine and runs `app` on it. */
export function run(app: App, options: BootOptions = {}): Runtime {
    const runtime = boot(options);
    runtime.run(app);
    return runtime;
}
