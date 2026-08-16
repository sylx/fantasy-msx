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
        summary: "A game. Painted ground kills the drifters, but paint takes the blitter several frames to lay, so you aim at where they are going.",
        controls: "arrows / WASD to fly · Z to spray · X to start",
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
