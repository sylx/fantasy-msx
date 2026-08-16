// The BIOS: drawing, sprites and display control on top of the typed chip API.

import { createSystem, type System } from "../api/index.js";
import { Graphics } from "./gfx.js";
import { Screen } from "./screen.js";
import { Sprites } from "./sprites.js";

export { Graphics, type BlitOptions, type Rect } from "./gfx.js";
export { Screen, SPRITE_ATTRIBUTE_TABLE, SPRITE_COLOR_TABLE, SPRITE_PATTERN_TABLE } from "./screen.js";
export { Sprites, SPRITE_COUNT, SPRITE_FLAGS, type SpriteState } from "./sprites.js";
export { CHAR_HEIGHT, CHAR_WIDTH, FONT } from "./font.js";

export interface Bios {
    readonly system: System;
    readonly screen: Screen;
    readonly gfx: Graphics;
    readonly sprites: Sprites;
}

/** Brings up a machine in SCREEN 5 with sprites ready to use. */
export function createBios(system: System = createSystem()): Bios {
    const screen = new Screen(system.vdp, system.machine);
    screen.setMode("G4");

    const bios: Bios = {
        system,
        screen,
        gfx: new Graphics(system.vdp, screen),
        sprites: new Sprites(system.vdp)
    };
    bios.sprites.setSize(16);
    bios.sprites.setEnabled(true);

    // The mode's geometry reaches the raster at the next vertical sync.
    system.machine.frame();
    return bios;
}
