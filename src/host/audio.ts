// Turning what the chips generated into samples a host can play.
//
// The PSG runs at 112005 Hz and the OPLL at 49780, neither of which is a rate
// any sound card wants. Each chip fills its own ring buffer as the VDP clocks
// it; this pulls a frame's worth from each, resamples to the output rate and
// sums them.
//
// Downsampling is done by averaging the input samples that fall inside an
// output sample rather than picking one of them. Picking would alias the PSG's
// square waves badly - it is more than twice the output rate.

import type { FantasyMachine } from "../core/machine.js";
import type { AudioSignal } from "../core/types.js";

interface SignalState {
    signal: AudioSignal;
    /** Input samples per output sample. */
    factor: number;
    /** Fractional input position carried between calls. */
    position: number;
    /** Last input sample, for interpolating when the output rate is the higher one. */
    previous: number;
}

/** Corner frequency of the DC blocker, in Hz. Below anything anyone can hear. */
const DC_BLOCK_HZ = 20;

export class AudioMixer {
    private readonly states = new Map<AudioSignal, SignalState>();
    private dcInput = 0;
    private dcOutput = 0;
    private readonly dcPole: number;

    /**
     * Master gain. The chips leave headroom deliberately - PSG and OPLL
     * playing together have to fit - so a program using only one of them can
     * afford to turn this up.
     */
    volume = 1;

    constructor(private readonly machine: FantasyMachine, readonly sampleRate: number) {
        this.dcPole = 1 - (2 * Math.PI * DC_BLOCK_HZ) / sampleRate;
    }

    /** How many samples one frame is worth at the output rate. */
    get samplesPerFrame(): number {
        return this.sampleRate / 60;
    }

    /**
     * Mixes the audio generated so far into `output`, which is left as
     * silence where no chip has anything to say. Mono: both PSG and OPLL are
     * mono unless the volume and pan settings say otherwise, and ours do not.
     */
    render(output: Float32Array): void {
        output.fill(0);
        const count = output.length;

        for (const signal of this.machine.getAudioSignals()) {
            const state = this.stateFor(signal);
            const wanted = count * state.factor + state.position;
            const quantity = Math.ceil(wanted);
            const result = signal.retrieveSamples(quantity, false) as unknown as {
                buffer0: ArrayLike<number>;
                bufferSize: number;
                start: number;
            };

            const buffer = result.buffer0;
            const size = result.bufferSize;
            let position = state.position;

            for (let i = 0; i < count; ++i) {
                const from = position;
                const to = position + state.factor;

                if (state.factor >= 1) {
                    // More input than output: average the whole span.
                    let sum = 0;
                    let taken = 0;
                    for (let s = Math.floor(from); s < to; ++s) {
                        sum += buffer[(result.start + s) % size];
                        ++taken;
                    }
                    output[i] += taken > 0 ? sum / taken : state.previous;
                    state.previous = output[i];
                } else {
                    // More output than input: slide between neighbours.
                    const index = Math.floor(from);
                    const fraction = from - index;
                    const a = buffer[(result.start + index) % size];
                    const b = buffer[(result.start + index + 1) % size];
                    output[i] += a + (b - a) * fraction;
                }
                position = to;
            }

            // Keep only the fraction: the whole samples have been consumed.
            state.position = position - Math.floor(position);
        }

        this.blockDC(output);
    }

    /**
     * Removes the constant offset the chips leave behind.
     *
     * A PSG channel with its mixer bit off still drives its amplitude out as a
     * steady level - that is how the chip was made to play samples - and the
     * OPLL rests off centre too. On a real MSX the capacitor on the output
     * strips it. Without this the offset is inaudible but eats headroom, and
     * every start and stop arrives as a click.
     */
    private blockDC(output: Float32Array): void {
        for (let i = 0; i < output.length; ++i) {
            const input = output[i];
            this.dcOutput = input - this.dcInput + this.dcPole * this.dcOutput;
            this.dcInput = input;
            output[i] = this.dcOutput * this.volume;
        }
    }

    /** Forgets buffered audio. Hosts call this after a pause, to avoid a burst. */
    flush(): void {
        for (const signal of this.machine.getAudioSignals()) signal.flush();
        this.states.clear();
        this.dcInput = this.dcOutput = 0;
    }

    private stateFor(signal: AudioSignal): SignalState {
        let state = this.states.get(signal);
        if (!state) {
            state = { signal, factor: signal.getSampleRate() / this.sampleRate, position: 0, previous: 0 };
            this.states.set(signal, state);
        }
        return state;
    }
}

/**
 * The AudioWorklet that actually feeds the sound card.
 *
 * It cannot run the emulator - that lives on the main thread - so it is only a
 * sink: chunks of samples arrive by message, and it plays them back one buffer
 * at a time. Silence covers an underrun, and a backlog past a few frames is
 * dropped rather than allowed to turn into latency.
 */
const WORKLET_SOURCE = `
class FantasyMsxSink extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this.chunks = [];
        this.offset = 0;
        this.queued = 0;
        this.maxQueued = options.processorOptions.maxQueued;
        this.port.onmessage = (event) => {
            if (event.data === "flush") {
                this.chunks.length = 0;
                this.offset = 0;
                this.queued = 0;
                return;
            }
            this.chunks.push(event.data);
            this.queued += event.data.length;
        };
    }

    process(inputs, outputs) {
        const channels = outputs[0];
        const left = channels[0];

        // Drop the oldest audio rather than let a backlog become latency.
        while (this.queued > this.maxQueued && this.chunks.length > 1) {
            this.queued -= this.chunks[0].length - this.offset;
            this.chunks.shift();
            this.offset = 0;
        }

        for (let i = 0; i < left.length; ++i) {
            while (this.chunks.length > 0 && this.offset >= this.chunks[0].length) {
                this.chunks.shift();
                this.offset = 0;
            }
            const sample = this.chunks.length > 0 ? this.chunks[0][this.offset++] : 0;
            if (this.chunks.length > 0) --this.queued;
            for (let c = 0; c < channels.length; ++c) channels[c][i] = sample;
        }
        return true;
    }
}
registerProcessor("fantasy-msx-sink", FantasyMsxSink);
`;

/** Frames of audio allowed to pile up before the worklet starts dropping. */
const MAX_QUEUED_FRAMES = 4;

export class WebAudioOutput {
    private context: AudioContext | null = null;
    private node: AudioWorkletNode | null = null;
    private mixer: AudioMixer | null = null;
    private buffer = new Float32Array(0);

    constructor(private readonly machine: FantasyMachine) {}

    get sampleRate(): number {
        return this.context?.sampleRate ?? 0;
    }

    /** True once the context is running and samples are being accepted. */
    get playing(): boolean {
        return this.context?.state === "running" && this.node !== null;
    }

    /**
     * Opens the audio device. Browsers keep the context suspended until a user
     * gesture, so call `resume` from a key or pointer handler as well.
     */
    async start(): Promise<void> {
        if (this.context) return;

        const context = new AudioContext({ latencyHint: "interactive" });
        this.context = context;

        const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
        try {
            await context.audioWorklet.addModule(url);
        } finally {
            URL.revokeObjectURL(url);
        }

        const perFrame = Math.ceil(context.sampleRate / 60);
        this.mixer = new AudioMixer(this.machine, context.sampleRate);
        this.buffer = new Float32Array(perFrame);

        this.node = new AudioWorkletNode(context, "fantasy-msx-sink", {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [2],
            processorOptions: { maxQueued: perFrame * MAX_QUEUED_FRAMES }
        });
        this.node.connect(context.destination);
    }

    /** Renders one frame of audio and hands it to the worklet. */
    push(): void {
        if (!this.mixer || !this.node) return;
        this.mixer.render(this.buffer);
        // A copy, because the worklet keeps it until it has been played.
        this.node.port.postMessage(this.buffer.slice());
    }

    async resume(): Promise<void> {
        if (this.context?.state === "suspended") await this.context.resume();
    }

    /** Throws away buffered audio, so a pause does not end in a burst. */
    flush(): void {
        this.mixer?.flush();
        this.node?.port.postMessage("flush");
    }

    async stop(): Promise<void> {
        this.node?.disconnect();
        this.node = null;
        this.mixer = null;
        await this.context?.close();
        this.context = null;
    }
}
