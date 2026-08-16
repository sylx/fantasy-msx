// The BIOS: drawing, sprites and display control on top of the typed chip API.

import { createSystem, type System } from "../api/index.js";
import { Blitter } from "./blitter.js";
import { Graphics } from "./gfx.js";
import { Raster } from "./raster.js";
import { Screen } from "./screen.js";
import { SoundDriver } from "./sound.js";
import { Sprites } from "./sprites.js";

export { Blitter, COST, type Job } from "./blitter.js";
export { Graphics } from "./gfx.js";
export { Raster, type BlitOptions, type Rect } from "./raster.js";
export { Screen, type SpriteTables } from "./screen.js";
export { Sprites, SPRITE_COUNT, SPRITE_FLAGS, type SpriteState } from "./sprites.js";
export { CHAR_HEIGHT, CHAR_WIDTH, FONT, glyphOffset } from "./font.js";
export { SoundDriver } from "./sound.js";
export {
    compile, compileTrack, semitoneToHz, MMLError,
    opllVoice, psgVoice, rhythmVoice,
    type Event, type Song, type Track, type TrackSource, type Voice
} from "./mml.js";

export interface Bios {
    readonly system: System;
    readonly screen: Screen;
    /** Drawing. Queued, and paced by the hardware. */
    readonly gfx: Graphics;
    readonly sprites: Sprites;
    /** The queue behind `gfx`. Advanced automatically as the machine runs. */
    readonly blitter: Blitter;
    /** Music and effects, stepped once per frame on the vertical interrupt. */
    readonly bgm: SoundDriver;
}

/** Brings up a machine in SCREEN 5 with sprites ready to use. */
export function createBios(system: System = createSystem()): Bios {
    const screen = new Screen(system.vdp, system.machine);
    screen.setMode("G4");

    const blitter = new Blitter(new Raster(system.vdp, screen));
    // The blitter advances on the CPU's time slices, so it makes progress for
    // as long as the machine is running, whether or not anyone asks it to.
    system.machine.onCycles = (cycles) => blitter.step(cycles);

    const bios: Bios = {
        system,
        screen,
        gfx: new Graphics(screen, blitter, new Raster(system.vdp, screen)),
        sprites: new Sprites(system.vdp, screen),
        blitter,
        bgm: new SoundDriver(system.psg, system.opll)
    };

    // The driver runs on the vertical interrupt, which is where an MSX music
    // driver hooked itself and why tempo lands on whole frames.
    system.machine.onFrame = () => bios.bgm.tick();
    bios.sprites.setSize(16);
    bios.sprites.setEnabled(true);

    // The mode's geometry reaches the raster at the next vertical sync.
    system.machine.frame();
    return bios;
}
