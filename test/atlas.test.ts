import { describe, expect, it } from "vitest";
import {
    VramAtlas, charCells, createBios, textCells,
    type Bios, type Coverage, type ResolvedStyle
} from "../src/index.js";

/**
 * A rasteriser standing in for the browser's. Every glyph is a solid block the
 * width the character deserves, so what lands in the page is checkable: a
 * full-width character comes back twice as wide as a half-width one.
 */
function blocks(cellWidth = 16, height = 16) {
    const rasterise = (text: string, _style: ResolvedStyle): Coverage => {
        const wide = charCells(text.codePointAt(0) ?? 32) === 2;
        const width = wide ? cellWidth * 2 : cellWidth;
        const alpha = new Uint8Array(width * height);
        // Solid, except for a one-pixel margin, so placement is visible.
        for (let y = 1; y < height - 1; ++y) {
            for (let x = 1; x < width - 1; ++x) alpha[y * width + x] = 255;
        }
        return { width, height, alpha, baseline: height - 2, lineHeight: height };
    };
    return rasterise;
}

function withAtlas(mode: "G4" | "G6" = "G6", options = {}): { bios: Bios; atlas: VramAtlas } {
    const bios = createBios();
    bios.screen.setMode(mode);
    bios.text.rasteriser = blocks();
    const atlas = new VramAtlas(bios.system.vdp, bios.screen, bios.text, { page: 1, ...options });
    bios.console.setFont(atlas);
    return { bios, atlas };
}

describe("East Asian width", () => {
    it("gives kana and kanji two cells and Latin one", () => {
        expect(charCells("A".codePointAt(0)!)).toBe(1);
        expect(charCells("あ".codePointAt(0)!)).toBe(2);
        expect(charCells("漢".codePointAt(0)!)).toBe(2);
        expect(charCells("　".codePointAt(0)!)).toBe(2);      // full-width space
        expect(charCells("ｱ".codePointAt(0)!)).toBe(1);       // half-width katakana
        expect(textCells("あA漢")).toBe(5);
    });
});

describe("VramAtlas", () => {
    it("keeps a cell the same shape in both widths of mode", () => {
        // A 512-wide mode has pixels half as wide, so a cell there is twice as
        // many of them and holds twice the detail at the same size on screen.
        expect(withAtlas("G4").atlas.cellWidth).toBe(8);
        expect(withAtlas("G6").atlas.cellWidth).toBe(16);
        expect(withAtlas("G6").atlas.cellHeight).toBe(16);
    });

    it("lays 512 slots into the page, using the rows a display never shows", () => {
        // A SCREEN 7 page is 256 lines tall where the picture is 212, and the
        // spare rows hold glyphs like everything else.
        const { atlas } = withAtlas("G6");
        expect(atlas.stats.slots).toBe(512);
        expect(withAtlas("G4").atlas.stats.slots).toBe(512);
    });

    it("rasterises a character once and copies it thereafter", () => {
        const { atlas } = withAtlas();
        atlas.preload("ああああ");
        expect(atlas.stats.misses).toBe(1);
        expect(atlas.stats.glyphs).toBe(1);
        // A full-width glyph takes the pair of slots it is drawn across.
        expect(atlas.stats.used).toBe(2);

        atlas.preload("A");
        expect(atlas.stats.glyphs).toBe(2);
        expect(atlas.stats.used).toBe(3);
    });

    it("draws into the page it was given, not the one being shown", () => {
        const { bios, atlas } = withAtlas();
        const vram = bios.system.vdp.vram;
        const page1 = bios.screen.pageBase(1);

        atlas.preload("A");
        let ink = 0;
        for (let i = page1; i < page1 + 4096; ++i) if (vram[i] !== 0) ++ink;
        expect(ink).toBeGreaterThan(0);
        expect(atlas.page).toBe(1);
    });

    it("gives the colours at draw time, not at bake time", () => {
        const { bios, atlas } = withAtlas();
        const term = bios.console;
        term.color(15, 0);
        term.cls();
        term.text(0, 0, "A", 15, 0);
        term.flush();
        const cached = atlas.stats.glyphs;

        term.text(2, 0, "A", 6, 4);                       // the same glyph, other colours
        term.flush();

        const first = bios.console.cellRect(0, 0);
        const second = bios.console.cellRect(2, 0);
        expect(bios.gfx.getPixel(first.x + 4, first.y + 4)).toBe(15);
        expect(bios.gfx.getPixel(second.x + 4, second.y + 4)).toBe(6);
        expect(bios.gfx.getPixel(second.x, second.y)).toBe(4);
        // One glyph in the page, two sets of colours out of it.
        expect(atlas.stats.glyphs).toBe(cached);
    });

    it("evicts the least recently used glyph when the page is full", () => {
        const { atlas } = withAtlas();
        // 512 slots, two to a kanji: 256 of them fill the page exactly.
        let text = "";
        for (let i = 0; i < 256; ++i) text += String.fromCodePoint(0x4e00 + i);
        atlas.preload(text);
        expect(atlas.stats.used).toBe(512);
        expect(atlas.stats.evictions).toBe(0);

        atlas.preload("々");
        expect(atlas.stats.evictions).toBeGreaterThan(0);
        expect(atlas.stats.used).toBeLessThanOrEqual(512);
    });

    it("forgets everything when the face changes", () => {
        const { atlas } = withAtlas();
        atlas.preload("あいうえお");
        expect(atlas.stats.glyphs).toBe(5);

        atlas.setStyle({ size: 12 });
        expect(atlas.stats.glyphs).toBe(0);
        expect(atlas.stats.used).toBe(0);
    });
});

describe("a console with an atlas under it", () => {
    it("is 64 by 13 in SCREEN 7, which is 32 full-width characters", () => {
        const { bios } = withAtlas("G6");
        expect(bios.console.cols).toBe(32);
        expect(bios.console.rows).toBe(13);
    });

    it("gives a kanji two cells and keeps the caret out of the middle of it", () => {
        const { bios } = withAtlas();
        const term = bios.console;
        term.text(0, 0, "あA");

        expect(term.rowText(0).trimEnd()).toBe("あA");
        // "A" is in cell 2, not cell 1: the kana took two.
        term.locate(2, 0);
        expect(term.cursor.col).toBe(2);
        // Landing on the right half of the kana snaps back onto it.
        term.locate(1, 0);
        expect(term.cursor.col).toBe(0);
    });

    it("leaves no half characters behind when one is overwritten", () => {
        const { bios } = withAtlas();
        const term = bios.console;
        term.text(0, 0, "日本語");
        expect(term.rowText(0).trimEnd()).toBe("日本語");

        // Writing over the left half of the middle kanji strands its right
        // half, which becomes a space rather than half a picture.
        term.put(2, 0, "X");
        expect(term.rowText(0).trimEnd()).toBe("日X 語");
    });

    it("wraps a full-width character whole rather than splitting it", () => {
        const { bios } = withAtlas();
        const term = bios.console;
        term.locate(term.cols - 1, 0);                    // one cell left on the line
        term.write("あ");
        expect(term.rowText(0).trim()).toBe("");
        expect(term.rowText(1).trimEnd()).toBe("あ");
    });

    it("paints a kanji across both its cells", () => {
        const { bios } = withAtlas();
        const term = bios.console;
        term.color(15, 0);
        term.cls();
        term.text(0, 0, "あ", 15, 0);
        term.flush();

        const left = term.cellRect(0, 0);
        const right = term.cellRect(1, 0);
        expect(bios.gfx.getPixel(left.x + 4, left.y + 4)).toBe(15);
        expect(bios.gfx.getPixel(right.x + 4, right.y + 4)).toBe(15);
    });

    it("counts a kanji as one cell painted, not two", () => {
        const { bios } = withAtlas();
        const term = bios.console;
        term.cls();
        term.flush();

        term.text(0, 0, "あ");
        term.flush();
        expect(term.repainted).toBe(1);
    });
});
