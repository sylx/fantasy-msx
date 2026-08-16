// Structural types for the vendored WebMSX chip emulators.
//
// The vendored code is plain ES5 JavaScript that registers constructors on a
// global `wmsx` namespace. These interfaces describe only the surface we
// actually drive, so TypeScript can check our side of the boundary.

/** A frame delivered by the VDP. In the browser this is an HTMLCanvasElement. */
export interface FrameSource {
    width: number;
    height: number;
    /** Present only under the headless canvas shim; holds the rendered pixels. */
    imageData?: { width: number; height: number; data: Uint8ClampedArray };
}

export interface VideoSignal {
    connectMonitor(monitor: Monitor): void;
    getSignalName(): string;
}

/** What VideoSignal calls back into. WebMSX's Monitor, reduced to what we need. */
export interface Monitor {
    newFrame(signal: VideoSignal, image: FrameSource, sx: number, sy: number, sw: number, sh: number): void;
    signalOff(signal: VideoSignal): void;
    showOSD(message: string, overlap?: boolean, error?: boolean): void;
    setDisplayMetrics(signal: VideoSignal, width: number, height: number): void;
    setDebugMode(signal: VideoSignal, on: boolean): void;
    setOutputAutoMode(signal: VideoSignal, mode: number): void;
}

export interface VDP {
    setMachineType(type: number): void;
    setVideoStandard(standard: unknown): void;
    setVSynchMode(mode: number): void;
    getVideoSignal(): VideoSignal;
    powerOn(): void;
    powerOff(): void;
    reset(): void;
    /** Renders one pulldown cycle. With the TIMER pulldown that is exactly one frame. */
    videoClockPulse(): void;

    // Port-level interface, exactly as the Z80 would see it.
    input98(): number;              // VRAM read   (port 0x98)
    output98(val: number): void;    // VRAM write  (port 0x98)
    input99(): number;              // status read (port 0x99)
    output99(val: number): void;    // register / VRAM address write (port 0x99)
    output9a(val: number): void;    // palette write (port 0x9A)
    output9b(val: number): void;    // register indirect write (port 0x9B)

    getVDPCycles(): number;
    getScreenText(): string | null;
    /** The full 128KB VRAM, exposed by the VDP for direct access. */
    vram: Uint8Array;
}

export interface AudioSignal {
    audioClockPulse(): void;
    audioFinishFrame(): void;
    setFps(fps: number): void;
    flush(): void;
    getSampleRate(): number;
    retrieveSamples(quant: number, mute: boolean): Float32Array | null;
}

export interface WmsxNamespace {
    VDP: new (machine: unknown, cpu: unknown, vSyncConnection: unknown) => VDP;
    PSGAudio: new (secondary?: boolean) => any;
    YM2413Audio: new (...args: any[]) => any;
    VideoStandard: { NTSC: unknown; PAL: unknown };
    Util: any;
}
