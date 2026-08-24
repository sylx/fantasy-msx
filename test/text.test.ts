import { describe, expect, it } from "vitest";
import { createBios, type Coverage, type ResolvedStyle } from "../src/bios/index.js";

/**
 * A rasteriser standing in for the browser's, since Node has no text engine.
 * It draws a wedge: coverage rises left to right across the box, so a
 * threshold anywhere between 0 and 255 cuts it at a predictable column.
 */
function wedge(width = 8, height = 4) {
    const calls: Array<{ text: string; style: ResolvedStyle }> = [];
    const rasterise = (text: string, style: ResolvedStyle): Coverage => {
        calls.push({ text, style });
        const alpha = new Uint8Array(width * height);
        for (let y = 0; y < height; ++y) {
            for (let x = 0; x < width; ++x) alpha[y * width + x] = Math.round((x / (width - 1)) * 255);
        }
        return { width, height, alpha, baseline: height - 1, lineHeight: height };
    };
    return { rasterise, calls };
}

describe("Text from the host's fonts", () => {
    it("cuts the coverage at the threshold and paints the two sides", () => {
        const { text, gfx } = createBios();
        text.rasteriser = wedge().rasterise;
        gfx.now.clear(0);

        text.drawNow(0, 0, "x", { color: 15, background: 3, threshold: 128 });
        // Coverage reaches 128 at column 4 of 8; everything before it is the
        // background, everything from it on is ink.
        expect(gfx.getPixel(3, 0)).toBe(3);
        expect(gfx.getPixel(4, 0)).toBe(15);
        expect(gfx.getPixel(7, 3)).toBe(15);
    });

    it("leaves what is underneath alone when no background is asked for", () => {
        const { text, gfx } = createBios();
        text.rasteriser = wedge().rasterise;
        gfx.now.clear(7);

        const image = text.drawNow(0, 0, "x", { color: 15 });
        expect(image.transparent).toBe(true);
        expect(gfx.getPixel(0, 0)).toBe(7);         // uncovered: the clear survives
        expect(gfx.getPixel(7, 0)).toBe(15);
    });

    it("spends the coverage along the ramp, palest band first", () => {
        const { text, gfx } = createBios();
        text.rasteriser = wedge().rasterise;
        gfx.now.clear(0);

        // Three shades divide the wedge into four bands: background, then one
        // column pair each. The eight columns cover 0, 36, 73 ... 255.
        text.drawNow(0, 0, "x", { shades: [1, 2, 3], background: 7 });
        expect([0, 1, 2, 3, 4, 5, 6, 7].map((x) => gfx.getPixel(x, 0)))
            .toEqual([7, 7, 1, 1, 2, 2, 3, 3]);
    });

    it("is exactly the threshold when the ramp is one entry long", () => {
        const { text } = createBios();
        text.rasteriser = wedge().rasterise;

        const ramp = text.render("x", { shades: [9], threshold: 96 }).pixels;
        const plain = text.render("x", { color: 9, threshold: 96 }).pixels;
        expect([...ramp]).toEqual([...plain]);
    });

    it("slides the whole ramp towards the ink as the threshold comes down", () => {
        const { text } = createBios();
        text.rasteriser = wedge().rasterise;

        const row = (threshold: number) =>
            [...text.render("x", { shades: [1, 2], threshold }).pixels.subarray(0, 8)];
        expect(row(128)).toEqual([0, 0, 1, 1, 1, 1, 2, 2]);
        // Half the threshold and every band reaches two columns further out.
        expect(row(64)).toEqual([1, 1, 1, 1, 2, 2, 2, 2]);
        expect(row(192)).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
    });

    it("takes the ramp in place of the colour, and tells them apart in the cache", () => {
        const { text } = createBios();
        const stub = wedge();
        text.rasteriser = stub.rasterise;

        const shaded = text.render("x", { color: 15, shades: [4, 5] });
        expect([...shaded.pixels.subarray(0, 8)]).toEqual([0, 0, 4, 4, 4, 4, 5, 5]);

        text.render("x", { color: 15 });                 // the same string, hard-edged
        text.render("x", { color: 15, shades: [4, 5] }); // and the ramp again
        expect(stub.calls.length).toBe(2);
    });

    it("assembles the CSS shorthand from the style, defaults included", () => {
        const { text } = createBios();
        const stub = wedge();
        text.rasteriser = stub.rasterise;

        text.render("x");
        text.render("x", { font: "'Press Start 2P', monospace", size: 8, weight: 700, italic: true });

        expect(stub.calls[0].style.font).toBe("16px sans-serif");
        expect(stub.calls[1].style.font).toBe("italic 700 8px 'Press Start 2P', monospace");
    });

    it("takes the stretch from the mode, so type keeps its shape in the 512-wide ones", () => {
        const { text, screen } = createBios();
        const stub = wedge();
        text.rasteriser = stub.rasterise;

        text.render("x");                           // SCREEN 5: square pixels
        screen.setMode("G6");
        text.render("x");                           // SCREEN 7: half as wide as tall
        expect(stub.calls.map((call) => call.style.stretch)).toEqual([1, 2]);

        // SCREEN 8 is square again, and a style asking for the mode's own
        // pixels comes to the same thing - both of which the cache already has.
        screen.setMode("G7");
        expect(text.render("x").pixels).toBe(text.render("x", { stretch: 1 }).pixels);
        expect(stub.calls.length).toBe(2);
    });

    it("takes its defaults from the style set on the typesetter", () => {
        const { text } = createBios();
        const stub = wedge();
        text.rasteriser = stub.rasterise;
        text.style = { font: "serif", size: 24 };

        text.render("x", { size: 12 });
        expect(stub.calls[0].style.font).toBe("12px serif");
    });

    it("renders a string once, however often it is drawn", () => {
        const { text } = createBios();
        const stub = wedge();
        text.rasteriser = stub.rasterise;

        text.render("score", { color: 15 });
        text.render("score", { color: 15 });
        expect(stub.calls.length).toBe(1);

        // A different colour is a different picture, and a reset forgets both.
        text.render("score", { color: 4 });
        expect(stub.calls.length).toBe(2);
        text.forget();
        text.render("score", { color: 15 });
        expect(stub.calls.length).toBe(3);
    });

    it("reports the box without drawing anything", () => {
        const { text, gfx } = createBios();
        text.rasteriser = wedge(8, 4).rasterise;
        gfx.now.clear(0);

        const box = text.measure("x");
        expect(box).toEqual({ width: 8, height: 4, baseline: 3, lineHeight: 4, lines: 1 });
        expect(gfx.getPixel(7, 0)).toBe(0);
    });

    it("goes through the blitter when queued, and arrives over several frames", () => {
        const { text, gfx, screen } = createBios();
        text.rasteriser = wedge(64, 32).rasterise;
        gfx.now.clear(0);

        text.draw(0, 0, "a long caption", { color: 15 });
        expect(gfx.busy).toBe(true);
        while (gfx.busy) screen.frame();
        expect(gfx.getPixel(63, 31)).toBe(15);
    });

    it("says so rather than guessing when the host has no text engine", () => {
        const { text } = createBios();
        expect(() => text.render("x")).toThrow(/rasteriser/);
    });
});
