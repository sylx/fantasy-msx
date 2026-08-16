// The low-level API: typed access to an MSX2's chips, and nothing more.
//
// Everything here maps one-to-one onto hardware. If you know how to program a
// V9938 or an AY-3-8910, this is the same knowledge with names attached. The
// drawing and music libraries are built on top of it, not into it.

import { FantasyMachine } from "../core/machine.js";
import { Opll } from "./opll.js";
import { Psg } from "./psg.js";
import { Vdp } from "./vdp.js";

export { Vdp, VdpCommands, type TableLayout } from "./vdp.js";
export { Psg, type Channel, ENVELOPE, MIXER, PSG_R, TONE_CLOCK, USE_ENVELOPE } from "./psg.js";
export { Opll, type OpllChannel, BLOCK_BITS, INSTRUMENT, OPLL_R, RHYTHM, pitchToFrequency } from "./opll.js";
export * from "./v9938.js";
export { FantasyMachine, type Frame } from "../core/machine.js";

/** An MSX2's chips, wired to a machine that clocks them. */
export interface System {
    readonly machine: FantasyMachine;
    readonly vdp: Vdp;
    readonly psg: Psg;
    readonly opll: Opll;
}

export function createSystem(machine: FantasyMachine = new FantasyMachine()): System {
    return {
        machine,
        vdp: new Vdp(machine.vdp),
        psg: new Psg(machine.psg),
        opll: new Opll(machine.opll)
    };
}
