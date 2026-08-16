// The Fantasy MSX machine: an MSX2 with the Z80 removed.
//
// In a real MSX (and in WebMSX) the VDP is the master clock: it walks 262
// scanlines per frame and hands out CPU time in between, a few dozen cycles at
// a time. We keep that structure exactly, but the cycles are no longer spent
// executing Z80 opcodes - nothing consumes them except the cycle counter that
// the VDP's own command engine uses to time HMMV/LMMM/LINE completion.
//
// User code runs once per frame, before the VDP renders that frame's lines,
// which puts it in the same position as an MSX program's VBlank interrupt
// handler: writes land before the raster reaches them.

import wmsxNamespace from "./vendor/index.js";
import type { AudioSignal, FrameSource, Monitor, OpllChip, PsgChip, VDP, VideoSignal, WmsxNamespace } from "./types.js";

const wmsx = wmsxNamespace as WmsxNamespace;

/** MSX2 (V9938). Matches WebMSX's MACHINES_CONFIG TYPE numbering. */
const MACHINE_TYPE_MSX2 = 2;

/** NTSC with V-sync off gives the TIMER pulldown: 262 lines per clock pulse, i.e. 1:1 frames. */
const LINES_PER_FRAME = 262;
const FPS = 60;

export interface Frame {
    /** Canvas in the browser, headless stand-in under Node. */
    readonly source: FrameSource;
    readonly width: number;
    readonly height: number;
}

/**
 * Collects the audio signals of every sound chip and pumps them from the VDP's
 * line timing. WebMSX calls this the AudioSocket; ours drops the monitor and
 * mute plumbing, keeping only the clock distribution.
 */
class AudioSocket {
    private readonly signals: AudioSignal[] = [];
    private busCycles = () => 0;

    constructor(busCycles: () => number) {
        this.busCycles = busCycles;
        // The chips capture these as bare function references, so they must be bound.
        this.audioClockPulse32 = this.audioClockPulse32.bind(this);
        this.getBUSCycles = this.getBUSCycles.bind(this);
    }

    connectAudioSignal(signal: AudioSignal): void {
        if (this.signals.indexOf(signal) >= 0) return;
        this.signals.push(signal);
        this.flushAllSignals();          // keep every signal in step
        signal.setFps(FPS);
    }

    disconnectAudioSignal(signal: AudioSignal): void {
        const i = this.signals.indexOf(signal);
        if (i >= 0) this.signals.splice(i, 1);
    }

    /** Called by the VDP roughly every 32 CPU cycles, ~7.125 times per scanline. */
    audioClockPulse32(): void {
        for (let i = this.signals.length - 1; i >= 0; --i) this.signals[i].audioClockPulse();
    }

    audioFinishFrame(): void {
        for (let i = this.signals.length - 1; i >= 0; --i) this.signals[i].audioFinishFrame();
    }

    flushAllSignals(): void {
        for (let i = this.signals.length - 1; i >= 0; --i) this.signals[i].flush();
    }

    getBUSCycles(): number {
        return this.busCycles();
    }

    getSignals(): readonly AudioSignal[] {
        return this.signals;
    }
}

/**
 * Stands in for the Z80. It owns no state beyond the bus cycle counter, but
 * that counter is load-bearing: the VDP command engine finishes a blit when
 * getVDPCycles() (= busCycles * 6) passes the command's computed duration.
 */
class CycleCounter {
    private cycles = 0;
    /** Raised while the VDP is asserting its interrupt line. */
    intPending = false;
    /**
     * Handed every slice of time the Z80 would have had, roughly ten times per
     * scanline. This is where work that is supposed to take hardware time gets
     * done a little at a time.
     */
    onCycles: ((cycles: number) => void) | null = null;

    constructor() {
        this.busClockPulses = this.busClockPulses.bind(this);
        this.r800MemoryRefresh = this.r800MemoryRefresh.bind(this);
        this.getBUSCycles = this.getBUSCycles.bind(this);
        this.setINTChannel = this.setINTChannel.bind(this);
    }

    busClockPulses(quant: number): void {
        this.cycles += quant;
        if (this.onCycles) this.onCycles(quant);
    }

    /** R800-only bookkeeping. A Z80-speed machine does nothing here. */
    r800MemoryRefresh(): void {}

    getBUSCycles(): number {
        return this.cycles;
    }

    setINTChannel(_channel: number, value: number): void {
        this.intPending = value === 0;      // active low
    }

    reset(): void {
        this.cycles = 0;
        this.intPending = false;
    }
}

/** Receives finished frames from the VDP's VideoSignal. */
class FrameCollector implements Monitor {
    frame: Frame | null = null;
    displayWidth = 0;
    displayHeight = 0;

    newFrame(_signal: VideoSignal, image: FrameSource, _sx: number, _sy: number, sw: number, sh: number): void {
        this.frame = { source: image, width: sw, height: sh };
    }

    signalOff(): void {
        this.frame = null;
    }

    setDisplayMetrics(_signal: VideoSignal, width: number, height: number): void {
        this.displayWidth = width;
        this.displayHeight = height;
    }

    showOSD(): void {}
    setDebugMode(): void {}
    setOutputAutoMode(): void {}
}

export class FantasyMachine {
    readonly vdp: VDP;
    readonly psg: PsgChip;
    readonly opll: OpllChip;

    private readonly cpu = new CycleCounter();
    private readonly audioSocket: AudioSocket;
    private readonly collector = new FrameCollector();
    private frameCount = 0;

    /** Runs once per frame, before that frame's scanlines are rendered (VBlank position). */
    onFrame: (() => void) | null = null;

    constructor() {
        this.audioSocket = new AudioSocket(() => this.cpu.getBUSCycles());

        // What the VDP expects of its "machine": an audio socket, the host
        // refresh rate (we never V-sync, so 0 = undetected), and a hook for
        // software PAL/NTSC switching, which a fixed-standard console ignores.
        const machine = {
            getAudioSocket: () => this.audioSocket,
            getVideoClockSocket: () => ({ getVSynchNativeFrequency: () => 0 }),
            setVideoStandardSoft: () => {}
        };

        // Fired at the top of each frame by the VDP. We drive user code from
        // frame() instead, so this stays empty.
        const vSyncConnection = { vSyncPulse: () => {} };

        // The OPLL registers itself on the I/O bus when connected. With no Z80
        // there are no port reads to service, so the bus accepts and forgets.
        const bus = {
            connectInputDevice: () => {}, connectOutputDevice: () => {},
            disconnectInputDevice: () => {}, disconnectOutputDevice: () => {}
        };
        Object.assign(machine, { bus });

        this.vdp = new wmsx.VDP(machine, this.cpu, vSyncConnection);
        this.vdp.setMachineType(MACHINE_TYPE_MSX2);
        this.vdp.setVideoStandard(wmsx.VideoStandard.NTSC);
        this.vdp.setVSynchMode(0);                       // off -> TIMER pulldown -> 262 lines/pulse
        this.vdp.getVideoSignal().connectMonitor(this.collector);
        this.vdp.powerOn();

        this.psg = new wmsx.PSGAudio();
        this.psg.setAudioSocket(this.audioSocket);
        this.psg.powerOn();

        // The OPLL attaches its audio signal lazily, on the first register
        // write, so it costs nothing until a program actually uses FM.
        this.opll = new wmsx.YM2413Audio("OPLL");
        this.opll.connect(machine);
        this.opll.powerOn();
    }

    /** Advances the machine by exactly one frame (262 scanlines). */
    frame(): void {
        this.onFrame?.();
        this.vdp.videoClockPulse();
        this.audioSocket.audioFinishFrame();
        ++this.frameCount;
    }

    /** The most recently completed frame, or null before the first one. */
    getFrame(): Frame | null {
        return this.collector.frame;
    }

    get frames(): number {
        return this.frameCount;
    }

    /** CPU-equivalent cycles elapsed. The VDP times its blits against this. */
    get cycles(): number {
        return this.cpu.getBUSCycles();
    }

    /** True while the VDP is asserting the vertical interrupt line. */
    get interruptPending(): boolean {
        return this.cpu.intPending;
    }

    /**
     * Subscribes to the CPU's time slices - about ten per scanline, 2620 per
     * frame. Anything that should visibly take hardware time advances here
     * rather than all at once.
     */
    set onCycles(consumer: ((cycles: number) => void) | null) {
        this.cpu.onCycles = consumer;
    }

    get onCycles(): ((cycles: number) => void) | null {
        return this.cpu.onCycles;
    }

    /** Pulls the accumulated audio for the last frame from every connected chip. */
    getAudioSignals(): readonly AudioSignal[] {
        return this.audioSocket.getSignals();
    }

    reset(): void {
        this.cpu.reset();
        this.vdp.reset();
        this.psg.reset();
        this.opll.reset();
        this.frameCount = 0;
    }
}

export const LINES = LINES_PER_FRAME;
