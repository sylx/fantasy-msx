// Plays a tune through the driver and writes it out, so the music path can be
// judged by ear. Eight bars, five voices, looping cleanly.

import { writeFileSync } from "node:fs";
import { compile, createBios, opllVoice, psgVoice, rhythmVoice } from "../src/bios/index.js";
import { AudioMixer } from "../src/host/audio.js";
import { encodeWAV } from "./wav.js";

const RATE = 48000;
const bios = createBios();
const mixer = new AudioMixer(bios.system.machine, RATE);
mixer.volume = 2.2;             // the chips leave room for each other; this is a full mix

// A minor - F - C - G, twice.
const song = compile([
    // Lead: eighths, released a little short so the line articulates.
    { voice: psgVoice(0), mml: "t150 v13 q7 l8 o5 [eagaece4 fagafcf4 egecgec4 dgfgdbg4]2" },
    // Bass: the root of each chord, four to the bar.
    { voice: psgVoice(1), mml: "t150 v11 q6 l4 o2 [aaaa ffff cccc gggg]2" },
    // Arpeggios, quiet and short, filling the gaps between the other two.
    { voice: psgVoice(2), mml: "t150 v7 q3 l16 o4 [[acea]4 [facf]4 [egce]4 [gbdg]4]2" },
    // A held pad on the FM chip, one chord per bar.
    { voice: opllVoice(0), mml: "t150 @8 v12 l1 o3 [afcg]2" },
    { voice: opllVoice(1), mml: "t150 @8 v9 l1 o4 [caeb]2" },
    // Kick and snare on the beat, hi-hat between.
    { voice: rhythmVoice(), mml: "t150 v12 l8 [{cg}g{dg}g{cg}g{dg}g]8" }
]);

const lengths = song.tracks.map((track) => track.frames);
console.log(`track lengths: ${lengths.join(", ")} frames`);
if (new Set(lengths).size !== 1) console.warn("!! tracks are not the same length, the loop will drift");

bios.bgm.play(song, { loop: true });

const frames = Number(process.argv[3] ?? lengths[0] * 2 + 30);
const chunk = new Float32Array(Math.round(RATE / 60));
const all = new Float32Array(chunk.length * frames);
for (let i = 0; i < frames; ++i) {
    bios.screen.frame();        // the driver ticks on the vertical interrupt
    mixer.render(chunk);
    all.set(chunk, i * chunk.length);
}

const out = process.argv[2] ?? "music.wav";
writeFileSync(out, encodeWAV(all, RATE));
const peak = all.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
console.log(`${out}: ${(frames / 60).toFixed(2)}s, peak ${peak.toFixed(3)}${peak >= 1 ? "  (CLIPPING)" : ""}`);
