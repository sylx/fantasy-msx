// Minimal WAV writer, so audio can be listened to outside a browser.

/** 16-bit PCM. `samples` are -1..1 and get clipped, not wrapped. */
export function encodeWAV(samples: Float32Array, sampleRate: number, channels = 1): Buffer {
    const bytesPerSample = 2;
    const data = Buffer.alloc(samples.length * bytesPerSample);
    for (let i = 0; i < samples.length; ++i) {
        const clipped = Math.max(-1, Math.min(1, samples[i]));
        data.writeInt16LE(Math.round(clipped * 32767), i * bytesPerSample);
    }

    const header = Buffer.alloc(44);
    header.write("RIFF", 0, "ascii");
    header.writeUInt32LE(36 + data.length, 4);
    header.write("WAVE", 8, "ascii");
    header.write("fmt ", 12, "ascii");
    header.writeUInt32LE(16, 16);                                   // chunk size
    header.writeUInt16LE(1, 20);                                    // PCM
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
    header.writeUInt16LE(channels * bytesPerSample, 32);
    header.writeUInt16LE(bytesPerSample * 8, 34);
    header.write("data", 36, "ascii");
    header.writeUInt32LE(data.length, 40);

    return Buffer.concat([header, data]);
}
