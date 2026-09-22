// The BIOS: drawing, sprites and display control on top of the typed chip API.

import { createSystem, type System } from "../api/index.js";
import { Blitter } from "./blitter.js";
import { Console } from "./console.js";
import { Graphics } from "./gfx.js";
import { Ime } from "./ime.js";
import { Images } from "./image.js";
import { Raster } from "./raster.js";
import { Screen } from "./screen.js";
import type { Scroll } from "./scroll.js";
import { SoundDriver } from "./sound.js";
import { Sprites } from "./sprites.js";
import { Typesetter } from "./text.js";
import { Tiles } from "./tiles.js";

export { VramAtlas, type AtlasOptions, type AtlasStats } from "./atlas.js";
export { Blitter, COST, type Job } from "./blitter.js";
export { Console, romFont, type GlyphSource } from "./console.js";
export { Graphics } from "./gfx.js";
export {
    Ime,
    type ImeCallbacks, type ImeSegment, type ImeSession, type ImeSessionFactory, type KeyTap
} from "./ime.js";
export {
    Images,
    type Dither, type DrawOptions, type Fit, type ImageDecoder, type IndexedImage,
    type PaletteOptions, type ReduceOptions, type RgbaImage
} from "./image.js";
export { Raster, type BlitOptions, type Rect } from "./raster.js";
export {
    Typesetter, rasteriseWithCanvas,
    type Coverage, type ResolvedStyle, type TextAlign, type TextBox,
    type TextImage, type TextRasteriser, type TextStyle
} from "./text.js";
export { Screen, PATTERN_TABLES, isPatternMode, type PatternModeName, type SpriteTables } from "./screen.js";
export {
    Tiles, TILE_COLUMNS, TILE_ROWS, bankOfRow,
    type DefineOptions, type FontOptions, type TileOptions
} from "./tiles.js";
export { Scroll, PLANE_HEIGHT, type BandOptions, type ScrollBand } from "./scroll.js";
export {
    Sprites, SPRITE_COUNT, SPRITE_FLAGS, splitMulticolor,
    type MulticolorPattern, type MulticolorSplit, type MulticolorState, type SpriteState
} from "./sprites.js";
export { CHAR_HEIGHT, CHAR_WIDTH, FONT, glyphOffset } from "./font.js";
export { SoundDriver } from "./sound.js";
export { charCells, textCells } from "./width.js";
export {
    compile, compileTrack, semitoneToHz, MMLError,
    opllVoice, psgVoice, rhythmVoice,
    type Event, type Song, type Track, type TrackSource, type Voice
} from "./mml.js";

export interface Bios {
    readonly system: System;
    readonly screen: Screen;
    /** Where the display looks into the plane, split into bands if you like. The same as `screen.scroll`. */
    readonly scroll: Scroll;
    /** Drawing. Queued, and paced by the hardware. */
    readonly gfx: Graphics;
    readonly sprites: Sprites;
    /** Characters: the name table and PCG of SCREEN 1, 2 and 4. Only usable in those modes. */
    readonly tiles: Tiles;
    /** Pictures from outside the machine, reduced to what the mode can show. */
    readonly image: Images;
    /** Text in the host's own fonts, rasterised outside the machine and carried in. */
    readonly text: Typesetter;
    /** A character grid over the bitmap, for the screens made of text. */
    readonly console: Console;
    /** Japanese input. Inert until an engine is attached to it. */
    readonly ime: Ime;
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

    const gfx = new Graphics(screen, blitter, new Raster(system.vdp, screen));
    const bios: Bios = {
        system,
        screen,
        scroll: screen.scroll,
        gfx,
        sprites: new Sprites(system.vdp, screen),
        tiles: new Tiles(system.vdp, screen),
        image: new Images(screen, gfx),
        text: new Typesetter(gfx, screen),
        console: new Console(gfx, screen),
        ime: new Ime(),
        blitter,
        bgm: new SoundDriver(system.psg, system.opll)
    };

    // The vertical sync loads the scroll's top band and the sprites' Y against
    // it. The music driver runs there too, which is where an MSX music driver
    // hooked itself and why tempo lands on whole frames.
    system.machine.onFrame = () => {
        bios.scroll.vsync();
        if (bios.scroll.active) bios.sprites.follow();
        bios.bgm.tick();
    };
    // The line interrupt is how the scroll's bands change partway down.
    system.machine.onInterrupt = () => bios.scroll.interrupt();
    bios.sprites.setSize(16);
    bios.sprites.setEnabled(true);

    // The mode's geometry reaches the raster at the next vertical sync.
    system.machine.frame();
    return bios;
}
