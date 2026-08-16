// Minimal global environment the vendored WebMSX core expects.
//
// WebMSX's chip emulators read two globals: `wmsx` (the class namespace they
// register themselves into) and `WMSX` (the emulator's configuration object).
// We recreate just the slice of both that the VDP/PSG/OPLL code actually
// touches, hard-wired to a single machine profile: MSX2 / V9938 / NTSC.
//
// This module is imported by every vendored file, so it always runs first.

import { createHeadlessDocument } from "./headless-canvas.js";

// --- Host shims (browser has these natively; Node does not) ---------------

if (typeof globalThis.window === "undefined") globalThis.window = globalThis;
if (typeof globalThis.performance === "undefined") globalThis.performance = { now: () => Date.now() };
if (typeof globalThis.window.performance === "undefined") globalThis.window.performance = globalThis.performance;
if (typeof globalThis.navigator === "undefined") {
    globalThis.navigator = { userAgent: "fantasy-msx", appName: "fantasy-msx", appVersion: "0", language: "en-US" };
}
if (typeof globalThis.document === "undefined") globalThis.document = createHeadlessDocument();

// --- wmsx: the class namespace -------------------------------------------

if (!globalThis.wmsx) globalThis.wmsx = {};

// The VDP derives its own base clock from the CPU's, so the constant has to
// exist even though no CPU does. 3584160 Hz is WebMSX's Z80 clock, rectified
// so that 262 lines x 228 cycles lands on exactly 60 Hz.
if (!globalThis.wmsx.CPU) globalThis.wmsx.CPU = { BASE_CLOCK: 3584160 };

// The VDP compares its configured type against these. We only ever use MSX2.
if (!globalThis.wmsx.Machine) globalThis.wmsx.Machine = {
    MACHINE_TYPE: { MSX1: 1, MSX2: 2, MSX2P: 3, MSXTR: 4 },
    // AudioSignal divides this by a chip's sample rate to pick its resampler:
    // /32 gives the PSG's 112005 Hz, /72 the OPLL's 49780 Hz.
    BASE_CPU_CLOCK: 3584160
};

// --- WMSX: configuration --------------------------------------------------

if (!globalThis.WMSX) {
    globalThis.WMSX = {
        // Machine profile. Fantasy MSX is MSX2-only, so this never varies.
        MACHINE: "MSX2J",
        MACHINES_CONFIG: { MSX2J: { DESC: "Fantasy MSX (MSX2 / V9938)", TYPE: 2 } },
        VDP_TYPE: 2,                    // 2 = V9938. Not "auto" - we pin it.

        // Debug switches the VDP consults at reset.
        DEBUG_MODE: 0,
        SPRITES_DEBUG_MODE: 0,

        // Audio mixing defaults, copied from WebMSX's own defaults.
        VOL: 1.0,
        PSG_VOL: "f",  PSG_PAN: "8",
        PSG2_VOL: "f", PSG2_PAN: "8",
        OPLL_VOL: "f", OPLL_PAN: "8",
        AUDIO_MONITOR_BUFFER_SIZE: -1,
        AUDIO_SIGNAL_BUFFER_RATIO: 2,
        AUDIO_SIGNAL_ADD_FRAMES: 3,

        // WebMSX's GUI room. Nothing in the chip code needs it, but VDP.reset()
        // reads WMSX.room?.screen for OSD messages in debug paths.
        room: undefined
    };
}

export const wmsx = globalThis.wmsx;
export const WMSX = globalThis.WMSX;
