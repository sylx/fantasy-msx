// A reproducible visit: the untouched island, planted seeds, rain, and night.
// Also record both actual sound chips, so the garden can be heard headlessly.
import { writeFileSync } from "node:fs";
import { AudioMixer, BUTTON, MOUSE, boot } from "../src/index.js";
import { createSeedDemo } from "../examples/seed/demo.js";
import { position } from "../examples/seed/garden.js";
import { readFrame, tile } from "./capture.js";
import { encodePNG } from "./png.js";
import { encodeWAV } from "./wav.js";

const runtime = boot();
runtime.run(createSeedDemo());
const mixer = new AudioMixer(runtime.bios.system.machine, 48000);
const audio: Float32Array[] = [];
const step = (frames: number) => {
    for (let i = 0; i < frames; ++i) {
        runtime.step();
        const samples = new Float32Array(800);
        mixer.render(samples);
        audio.push(samples);
    }
};
const shot = () => readFrame(runtime.bios.system.machine, runtime.screen.pixelAspect);
step(60);
const shots = [shot()];
for (const [x, y] of [[4, 5], [5, 5], [6, 5], [4, 6], [5, 6], [6, 6], [7, 6], [3, 7], [4, 7], [5, 7], [6, 7], [7, 7]]) {
    const p = position({ x, y });
    runtime.pointer.setPosition(p.x, p.y);
    runtime.pointer.setButton(MOUSE.LEFT, true);
    step(1);
    runtime.pointer.setButton(MOUSE.LEFT, false);
    step(1);
}
step(60);
shots.push(shot());
runtime.input.setButton(BUTTON.B, true);
step(1);
runtime.input.setButton(BUTTON.B, false);
step(240);
shots.push(shot());
step(1440 - runtime.frame);
shots.push(shot());

const sheet = tile(shots, 2);
const out = process.argv[2] ?? "seed.png";
writeFileSync(out, encodePNG(sheet.pixels, sheet.width, sheet.height));
if (process.argv[3]) {
    const samples = new Float32Array(audio.length * 800);
    audio.forEach((chunk, i) => samples.set(chunk, i * 800));
    writeFileSync(process.argv[3], encodeWAV(samples, 48000));
}
runtime.stop();
console.log(`${out}: four garden frames; ${audio.length / 60}s of PSG / FM audio${process.argv[3] ? ` in ${process.argv[3]}` : " (pass a second path to save WAV)"}`);
