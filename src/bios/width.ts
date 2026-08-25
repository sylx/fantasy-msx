// How many cells a character takes.
//
// A Japanese text screen is a grid of half-width cells in which the kanji and
// kana take two. That is not a rendering detail - it is the geometry MSX
// machines used (8x16 ANK against 16x16 kanji), and everything above it, from
// where the caret can land to where a line breaks, is counted in those cells.
//
// The rule is Unicode's East Asian Width: the characters classed Wide (W) or
// Fullwidth (F) take two, everything else takes one. The ranges below are that
// classification, coarse enough to be readable and exact where Japanese cares -
// half-width katakana (FF61..FF9F) are one cell, their full-width twins two.

/** Start and end, inclusive, of each run of double-width characters. */
const WIDE: ReadonlyArray<readonly [number, number]> = [
    [0x1100, 0x115f],   // Hangul Jamo initials
    [0x2e80, 0x303e],   // CJK radicals, Kangxi, CJK symbols and punctuation
    [0x3041, 0x33ff],   // kana, Bopomofo, Hangul compatibility, enclosed CJK
    [0x3400, 0x4dbf],   // CJK unified ideographs extension A
    [0x4e00, 0x9fff],   // CJK unified ideographs
    [0xa000, 0xa4cf],   // Yi
    [0xa960, 0xa97f],   // Hangul Jamo extended A
    [0xac00, 0xd7a3],   // Hangul syllables
    [0xf900, 0xfaff],   // CJK compatibility ideographs
    [0xfe10, 0xfe19],   // vertical forms
    [0xfe30, 0xfe6f],   // CJK compatibility forms, small form variants
    [0xff00, 0xff60],   // full-width Latin and punctuation
    [0xffe0, 0xffe6],   // full-width currency and signs
    [0x1f300, 0x1f64f], // pictographs and emoticons
    [0x1f900, 0x1f9ff], // supplemental symbols
    [0x20000, 0x2fffd], // CJK extensions B and up
    [0x30000, 0x3fffd]
];

/** 2 for the characters a Japanese screen sets in a double cell, 1 for the rest. */
export function charCells(code: number): 1 | 2 {
    for (const [low, high] of WIDE) {
        if (code < low) break;                          // the table is in order
        if (code <= high) return 2;
    }
    return 1;
}

/** Cells a whole string occupies, which is what wrapping and measuring want. */
export function textCells(text: string): number {
    let total = 0;
    for (const character of text) total += charCells(character.codePointAt(0) ?? 32);
    return total;
}
