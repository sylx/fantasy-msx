// What the launcher offers. Each entry loads its app on demand, so opening the
// page does not pull in every example's music and artwork.

import type { App } from "../src/index.js";

export interface Example {
    /** Also the URL fragment, so a particular one can be linked to. */
    readonly id: string;
    readonly title: string;
    readonly summary: string;
    readonly controls: string;
    readonly load: () => Promise<App>;
}

export const EXAMPLES: readonly Example[] = [
    {
        id: "ink",
        title: "INK",
        summary: "A game. Shots fly off in the direction you are flying and burst into a gradient of ink where they land. Painted ground kills the drifters, but the blitter takes several frames to lay a splat down, so you shoot at where they are going.",
        controls: "arrows / WASD to fly · Z to shoot · X to start",
        load: async () => (await import("./ink/game.js")).game
    },
    {
        id: "wire",
        title: "WIRE",
        summary: "A demo. SCREEN 7 at 512x212, an icosahedron redrawn whole every frame, and four FM voices over a PSG bass. X hands the same picture to the V9938's blitter, which manages five a second instead of sixty - drawn on the hidden page either way.",
        controls: "X to switch between software and the blitter",
        load: async () => (await import("./wire/demo.js")).demo
    },
    {
        id: "tone",
        title: "TONE",
        summary: "A picture, in every bitmap mode the V9938 has. A photograph is 24 bits a pixel and a V9938 framebuffer is four, two or eight - so the interesting question is not whether a picture survives the trip but which part of it does. Fetched and decoded once; everything after that is a reduction against the palette in the registers.",
        controls: "left / right for the screen mode · up / down for the dither · Z for the palette · X for the other picture · drop an image on the screen",
        load: async () => (await import("./tone/demo.js")).demo
    },
    {
        id: "type",
        title: "TYPE",
        summary: "A specimen sheet. The machine's own font is five pixels wide and stops at ASCII 126; this sets the same words in the browser's fonts instead, rasterised outside the machine and carried in a byte a pixel. What arrives is coverage, and it is spent on a ramp of palette entries - the swatches in the readout are the registers the smoothing costs. Z sets the same sheet in SCREEN 7, where the em is drawn twice as wide and the extra columns go into the letters.",
        controls: "left / right for the face \u00b7 up / down for the ramp \u00b7 Z for SCREEN 5 or 7 \u00b7 X for the specimen",
        load: async () => (await import("./type/demo.js")).demo
    },
    {
        id: "editor",
        title: "EDITOR",
        summary: "A Japanese text editor with nothing on screen the V9938 did not draw. A grid of 42 by 17 cells laid over a bitmap, glyphs cached in a spare VRAM page in place of the kanji ROM this machine never had, and Mozc running in a worker behind a session layer with no UI of its own - so the candidate list along the foot of the screen is cells in the same palette as the document. F1 switches between an outline face in SCREEN 7 and a bitmap one in SCREEN 5, which is a mode change because the face decides the mode. F2 puts the font page itself on the display. The whole visible page is re-emitted every frame and only the cells that changed reach VRAM: EDIT in the status bar counts them.",
        controls: "type \u00b7 F1 for the face and the mode \u00b7 F2 to look at the VRAM page \u00b7 Ctrl+Space for the dictionary, then kana or direct \u00b7 Space converts, 1-9 take a candidate, Enter settles \u00b7 arrows, Home / End, PageUp / PageDown, Backspace, Delete, Tab",
        load: async () => (await import("./editor/demo.js")).demo
    },
    {
        id: "loom",
        title: "LOOM",
        summary: "A composing machine. The chords come out of a Markov chain over scale degrees, the tune is a motif walked across them, and a sequencer on the vertical interrupt hands the lot to the chips a sixteenth at a time - four FM voices, the OPLL's rhythm mode, and the PSG doing the arpeggio, the echo and the hi-hat. The desk along the bottom is worked with the mouse: every part has the chip's own level, its own voice and a mute.",
        controls: "click a part's voice, fader or lamp \u00b7 NEW for another phrase \u00b7 AUTO to let it change on its own \u00b7 click a chord to re-roll that bar \u00b7 arrows and Z / X without a mouse",
        load: async () => (await import("./loom/demo.js")).demo
    },
    {
        id: "haze",
        title: "HAZE",
        summary: "A demo in SCREEN 3, the mode nobody used: 64x48 blocks of 4x4 pixels. The whole picture is 2048 bytes, so every block of it is recomputed every frame, while the palette rotates underneath and R23 scrolls the lot a quarter of a block at a time. The readout is four sprites, which is all a line of SCREEN 3 will show.",
        controls: "X for the next pattern - they change on their own every four bars",
        load: async () => (await import("./haze/demo.js")).demo
    }
];

export function findExample(id: string | null | undefined): Example {
    return EXAMPLES.find((example) => example.id === id) ?? EXAMPLES[0];
}
