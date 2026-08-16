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
        summary: "A demo. SCREEN 7 at 512x212, an icosahedron redrawn in software every frame across two pages, and four FM voices over a PSG bass.",
        controls: "nothing to press · sit back",
        load: async () => (await import("./wire/demo.js")).demo
    }
];

export function findExample(id: string | null | undefined): Example {
    return EXAMPLES.find((example) => example.id === id) ?? EXAMPLES[0];
}
