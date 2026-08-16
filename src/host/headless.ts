// A host that shows nothing and drives nothing.
//
// The runtime still needs somewhere to hand frames, and tests and the
// screenshot tools still need to step the clock themselves. This is that.

import type { Frame } from "../core/machine.js";
import type { Host } from "../runtime/runtime.js";

export class HeadlessHost implements Host {
    /** The most recent frame handed over. */
    frame: Frame | null = null;
    /** Set when `start` is called, so a test can tell a run from a step. */
    started = false;

    present(frame: Frame | null): void {
        this.frame = frame;
    }

    start(): void {
        this.started = true;        // nothing drives the clock; callers use step()
    }

    stop(): void {
        this.started = false;
    }
}
