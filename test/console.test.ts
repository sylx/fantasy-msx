import { describe, expect, it } from "vitest";
import { boot, createBios, Console, type Bios } from "../src/index.js";

function bios(mode: "G4" | "G6" = "G4"): Bios {
    const built = createBios();
    built.screen.setMode(mode);
    built.console.fit();
    return built;
}

/** Ink in one cell: how many of its pixels are not the background. */
function inkIn({ console: term, gfx }: Bios, col: number, row: number, background = 0): number {
    const rect = term.cellRect(col, row);
    let n = 0;
    for (let y = rect.y; y < rect.y + rect.height; ++y) {
        for (let x = rect.x; x < rect.x + rect.width; ++x) {
            if (gfx.getPixel(x, y) !== background) ++n;
        }
    }
    return n;
}

describe("Console", () => {
    it("fits the grid to the mode, in cells of the font", () => {
        const wide = bios("G6");
        expect(wide.console.cellWidth).toBe(6);
        expect(wide.console.cellHeight).toBe(8);
        expect(wide.console.cols).toBe(85);      // 512 / 6
        expect(wide.console.rows).toBe(26);      // 212 / 8

        const narrow = bios("G4");
        expect(narrow.console.cols).toBe(42);    // 256 / 6
        expect(narrow.console.rows).toBe(26);
    });

    it("refits itself when the mode has changed underneath it", () => {
        const built = bios("G4");
        expect(built.console.cols).toBe(42);

        built.screen.setMode("G6");
        built.console.flush();                   // notices, and starts over
        expect(built.console.cols).toBe(85);
    });

    it("writes at the cursor, wrapping and scrolling", () => {
        const built = bios("G4");
        const term = built.console;

        term.write("HELLO");
        expect(term.rowText(0).trimEnd()).toBe("HELLO");
        expect(term.cursor).toEqual({ col: 5, row: 0 });

        term.writeln();
        term.write("AGAIN");
        expect(term.rowText(1).trimEnd()).toBe("AGAIN");

        // Off the right edge and onto the next line.
        term.locate(term.cols - 2, 3);
        term.write("XY!");
        expect(term.rowText(3).endsWith("XY")).toBe(true);
        expect(term.rowText(4)[0]).toBe("!");
    });

    it("expands tabs to the next stop", () => {
        const term = bios("G4").console;
        term.write("AB\tC");
        expect(term.rowText(0).slice(0, 10)).toBe("AB      C ");
    });

    it("addresses cells without moving the cursor", () => {
        const term = bios("G4").console;
        term.locate(3, 3);
        term.text(0, 5, "STATUS");
        term.put(10, 6, "*");

        expect(term.rowText(5).trimEnd()).toBe("STATUS");
        expect(term.rowText(6)[10]).toBe("*");
        expect(term.cursor).toEqual({ col: 3, row: 3 });
    });

    it("paints only the cells that changed", () => {
        const built = bios("G4");
        const term = built.console;

        // The first flush owes the whole grid, since nothing has been drawn yet.
        term.flush();
        expect(term.repainted).toBe(term.cols * term.rows);

        // Re-emitting the same thing owes nothing at all.
        term.text(0, 0, "SAME");
        term.flush();
        const settled = term.repainted;
        term.text(0, 0, "SAME");
        term.flush();
        expect(term.repainted).toBe(0);
        expect(settled).toBe(4);

        // One character changed is one cell painted.
        term.text(0, 0, "SANE");
        term.flush();
        expect(term.repainted).toBe(1);
    });

    it("costs one cell a phase to blink a cursor, and nothing to hold it still", () => {
        const term = bios("G4").console;
        term.flush();

        term.locate(4, 2);
        term.cursorOn = true;
        term.flush();
        expect(term.repainted).toBe(1);

        term.flush();
        expect(term.repainted).toBe(0);          // still there, still the same

        term.cursorOn = false;
        term.flush();
        expect(term.repainted).toBe(1);          // and the cell underneath is back
    });

    it("draws the character it was given", () => {
        const built = bios("G4");
        built.console.put(1, 1, "W");
        built.console.flush();
        expect(inkIn(built, 1, 1)).toBeGreaterThan(0);
        expect(inkIn(built, 2, 1)).toBe(0);
    });

    it("scrolls the pixels rather than repainting them", () => {
        const built = bios("G4");
        const term = built.console;
        term.text(0, 0, "TOP");
        term.text(0, 1, "NEXT");
        term.flush();
        const moving = [0, 1, 2, 3].map((col) => inkIn(built, col, 1));
        expect(moving.every((ink) => ink > 0)).toBe(true);

        term.scroll(1);
        term.flush();

        expect(term.rowText(0).trimEnd()).toBe("NEXT");
        expect(term.rowText(term.rows - 1).trim()).toBe("");
        // Only the row the copy uncovered was owed any paint.
        expect(term.repainted).toBe(term.cols);
        // The pixels of the row that moved came with it rather than being drawn.
        expect([0, 1, 2, 3].map((col) => inkIn(built, col, 0))).toEqual(moving);
    });

    it("scrolls back the other way, and only inside the band it was given", () => {
        const built = bios("G4");
        const term = built.console;
        term.text(0, 0, "HEADER");
        term.text(0, 2, "BODY");
        term.text(0, term.rows - 1, "FOOTER");
        term.flush();

        // Rows 1 to rows-2 are the band; the two bars must not move.
        term.scroll(-1, 1, term.rows - 2);
        term.flush();

        expect(term.rowText(0).trimEnd()).toBe("HEADER");
        expect(term.rowText(term.rows - 1).trimEnd()).toBe("FOOTER");
        expect(term.rowText(3).trimEnd()).toBe("BODY");
        expect(term.rowText(1).trim()).toBe("");
        expect(term.repainted).toBe(term.cols);
    });

    it("blanks the band when asked to scroll further than it is tall", () => {
        const term = bios("G4").console;
        term.text(0, 4, "GONE");
        term.scroll(99, 4, 3);
        expect(term.rowText(4).trim()).toBe("");
    });

    it("takes the colours it was given, and inverts them under the cursor", () => {
        const built = bios("G4");
        const term = built.console;
        term.color(15, 4);
        term.cls();
        term.flush();
        // Every cell is now background 4, so nothing counts as ink against it.
        expect(inkIn(built, 0, 0, 4)).toBe(0);

        term.locate(0, 0);
        term.cursorOn = true;
        term.flush();
        // Inverted: the cell is now the ink colour with the paper's showing through.
        expect(inkIn(built, 0, 0, 4)).toBeGreaterThan(0);
    });

    it("is on the context, sized to whatever mode the app chose", () => {
        const runtime = boot();
        runtime.run({
            init: ({ screen, console: term }) => { screen.setMode("G6"); term.fit(); },
            update: ({ console: term }) => { term.text(0, 0, "READY"); term.flush(); }
        });
        runtime.step(1);

        expect(runtime.console).toBeInstanceOf(Console);
        expect(runtime.console.cols).toBe(85);
        expect(runtime.console.rowText(0).trimEnd()).toBe("READY");
    });
});
