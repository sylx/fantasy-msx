// The BIOS: drawing, sprites and display control on top of the typed chip API.

import { createSystem, type System } from "../api/index.js";
import { Blitter } from "./blitter.js";
import { Graphics } from "./gfx.js";
import { Raster } from "./raster.js";
import { Screen } from "./screen.js";
import { Sprites } from "./sprites.js";

export { Blitter, COST, type Job } from "./blitter.js";
export { Graphics } from "./gfx.js";
export { Raster, type BlitOptions, type Rect } from "./raster.js";
export { Screen, SPRITE_ATTRIBUTE_TABLE, SPRITE_COLOR_TABLE, SPRITE_PATTERN_TABLE } from "./screen.js";
export { Sprites, SPRITE_COUNT, SPRITE_FLAGS, type SpriteState } from "./sprites.js";
export { CHAR_HEIGHT, CHAR_WIDTH, FONT } from "./font.js";

export interface Bios {
    readonly system: System;
    readonly screen: Screen;
    /** Drawing. Queued, and paced by the hardware. */
    readonly gfx: Graphics;
    readonly sprites: Sprites;
    /** The queue behind `gfx`. Advanced automatically as the machine runs. */
    readonly blitter: Blitter;
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
        sprites: new Sprites(system.vdp),
        blitter
    };
    bios.sprites.setSize(16);
    bios.sprites.setEnabled(true);

    // The mode's geometry reaches the raster at the next vertical sync.
    system.machine.frame();
    return bios;
}
