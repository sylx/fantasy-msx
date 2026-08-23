// V9938 hardware constants.
//
// Nothing here is an abstraction - these are the register numbers, bit
// positions and opcodes as documented for the chip. If you know the V9938,
// you already know this file.

/** Control registers. The V9938 has 47 (R0..R46); all are write-only. */
export const R = {
    MODE_0: 0,              // Mx (M3-M5), IE1, IE2, DG
    MODE_1: 1,              // Mx (M1, M2), IE0, BL (display enable), SI, MAG
    LAYOUT_TABLE: 2,        // pattern layout table base / bitmap page base
    COLOR_TABLE: 3,         // colour table base, low
    PATTERN_TABLE: 4,       // pattern generator table base
    SPRITE_ATTR_TABLE: 5,   // sprite attribute table base, low
    SPRITE_PATTERN_TABLE: 6,
    COLOR: 7,               // text colour / backdrop colour
    MODE_2: 8,              // TP (transparency), SPD (sprite disable), colour bus, mouse
    MODE_3: 9,              // LN (192/212 lines), IL (interlace), EO (even/odd), NT (PAL/NTSC)
    COLOR_TABLE_HIGH: 10,
    SPRITE_ATTR_TABLE_HIGH: 11,
    BLINK_COLOR: 12,
    BLINK_PERIOD: 13,
    VRAM_ADDRESS_HIGH: 14,  // A16-A14 of the VRAM pointer
    STATUS_SELECT: 15,      // which S# register port 0x99 returns
    PALETTE_INDEX: 16,
    INDIRECT_INDEX: 17,     // register targeted by port 0x9B; bit 7 disables auto-increment
    ADJUST: 18,             // display position fine adjust
    LINE_INTERRUPT: 19,
    COLOR_BURST_1: 20,
    COLOR_BURST_2: 21,
    COLOR_BURST_3: 22,
    VERTICAL_OFFSET: 23,
    // Command engine
    SX: 32, SX_HIGH: 33,
    SY: 34, SY_HIGH: 35,
    DX: 36, DX_HIGH: 37,
    DY: 38, DY_HIGH: 39,
    NX: 40, NX_HIGH: 41,
    NY: 42, NY_HIGH: 43,
    CLR: 44,
    ARG: 45,
    CMD: 46
} as const;

/** R0 bits. */
export const R0 = {
    DG: 0x40,               // digitize
    IE2: 0x20,              // light pen interrupt enable
    IE1: 0x10,              // horizontal (line) interrupt enable
    MODE_MASK: 0x0e         // M3, M4, M5
} as const;

/** R1 bits. */
export const R1 = {
    BLANK: 0x40,            // BL: 1 = display enabled. Cleared means blanked, not powered off.
    IE0: 0x20,              // vertical (VBlank) interrupt enable
    MODE_MASK: 0x18,        // M1, M2
    CDR: 0x04,              // undocumented: blink period counts lines instead of frames
    SPRITE_SIZE: 0x02,      // SI: 1 = 16x16 sprites, 0 = 8x8
    SPRITE_MAG: 0x01        // MAG: 1 = pixels doubled
} as const;

/** R8 bits. */
export const R8 = {
    TRANSPARENT: 0x20,      // TP: 1 = colour 0 is opaque, 0 = colour 0 shows the backdrop
    SPRITE_DISABLE: 0x02,   // SPD
    BLACK_WHITE: 0x80,
    COLOR_BUS_INPUT: 0x40
} as const;

/** R9 bits. */
export const R9 = {
    LINES_212: 0x80,        // LN
    SIMULTANEOUS: 0x20,
    INTERLACE: 0x08,        // IL
    EVEN_ODD: 0x04,         // EO: alternate pages every field
    PAL: 0x02               // NT
} as const;

/** Status registers, selected through R15 and read from port 0x99. */
export const S = {
    INTERRUPT: 0,           // F (VBlank), 5S, C (collision), and the 5th sprite number
    STATUS: 1,              // FH (line interrupt), light pen, VDP id
    COMMAND: 2,             // CE (command executing), TR, VR, HR, BD, EO
    COLLISION_X_LOW: 3,
    COLLISION_X_HIGH: 4,
    COLLISION_Y_LOW: 5,
    COLLISION_Y_HIGH: 6,
    COLOR: 7,               // byte read back by LMCM / POINT
    BORDER_X_LOW: 8,
    BORDER_X_HIGH: 9
} as const;

/** S#0 bits. Reading S#0 clears F and the collision flag. */
export const S0 = {
    VBLANK: 0x80,           // F
    FIFTH_SPRITE: 0x40,     // 5S
    COLLISION: 0x20         // C
} as const;

/** S#2 bits. */
export const S2 = {
    COMMAND_EXECUTING: 0x01,    // CE
    TRANSFER_READY: 0x80,       // TR
    VERTICAL_RETRACE: 0x40,     // VR
    HORIZONTAL_RETRACE: 0x20,   // HR
    BORDER_DETECT: 0x10         // BD
} as const;

/** Command engine opcodes, occupying the high nibble of R46. */
export const CMD = {
    STOP: 0x00,
    POINT: 0x40,    // read one pixel into S#7
    PSET: 0x50,     // write one pixel
    SRCH: 0x60,     // scan a line for a colour
    LINE: 0x70,
    LMMV: 0x80,     // fill a rectangle, pixel coordinates
    LMMM: 0x90,     // copy VRAM to VRAM, pixel coordinates
    LMCM: 0xa0,     // copy VRAM to CPU, pixel coordinates
    LMMC: 0xb0,     // copy CPU to VRAM, pixel coordinates
    HMMV: 0xc0,     // fill a rectangle, byte coordinates (faster, no masking)
    HMMM: 0xd0,     // copy VRAM to VRAM, byte coordinates
    YMMM: 0xe0,     // copy VRAM to VRAM along Y only
    HMMC: 0xf0      // copy CPU to VRAM, byte coordinates
} as const;

/** Logical operations, occupying the low nibble of R46. */
export const OP = {
    IMP: 0x0,       // destination = source
    AND: 0x1,
    OR: 0x2,
    XOR: 0x3,
    NOT: 0x4,       // destination = ~source
    // "T" variants leave the destination untouched where the source is colour 0.
    TIMP: 0x8,
    TAND: 0x9,
    TOR: 0xa,
    TXOR: 0xb,
    TNOT: 0xc
} as const;

/** R45 (ARG) bits. */
export const ARG = {
    MAJOR_Y: 0x01,  // MAJ: LINE's long side is Y instead of X
    LEFT: 0x04,     // DIX: operate right-to-left
    UP: 0x08,       // DIY: operate bottom-to-top
    EXPANSION_RAM: 0x40
} as const;

export type ScreenModeName = "T1" | "T2" | "MC" | "G1" | "G2" | "G3" | "G4" | "G5" | "G6" | "G7";

export interface ScreenMode {
    /** VDP mode name. */
    readonly name: ScreenModeName;
    /** MSX-BASIC SCREEN number, for orientation. */
    readonly screen: number;
    /** Mode bits, as assembled from R1 bits 3-4 and R0 bits 1-3. */
    readonly bits: number;
    readonly width: number;
    readonly height: number;
    /** Simultaneous colours. */
    readonly colors: number;
    /** True for the bitmap modes, where the layout table is a framebuffer. */
    readonly bitmap: boolean;
    /** Bitmap modes only: pixels per byte, bytes per line, and VRAM per page. */
    readonly pixelsPerByte: number;
    readonly bytesPerLine: number;
    readonly pageSize: number;
    /** How many pages of this mode fit in 128KB of VRAM. */
    readonly pages: number;
    /**
     * Which address bits each table register actually selects in this mode.
     * The V9938 ignores the rest, but it also ORs them into the address mask
     * used while rendering, so they must be written as 1s - this is why
     * SCREEN 5 writes 0x1F to R2 rather than 0x00.
     */
    readonly tableMasks: TableMasks;
    /** G6/G7 store even and odd bytes in separate VRAM banks, which shifts R2. */
    readonly interleaved: boolean;
}

export interface TableMasks {
    readonly layout: number;
    readonly colors: number;
    readonly patterns: number;
    readonly spriteAttributes: number;
    readonly spritePatterns: number;
}

function mode(
    name: ScreenModeName, screen: number, bits: number, width: number, height: number, colors: number,
    bitmap: boolean, pixelsPerByte: number, bytesPerLine: number, pageSize: number,
    masks: { layout: number; colors: number; patterns: number; spriteAttributes: number }, interleaved = false
): ScreenMode {
    return {
        name, screen, bits, width, height, colors, bitmap, pixelsPerByte, bytesPerLine, pageSize,
        pages: pageSize ? 0x20000 / pageSize : 0,
        tableMasks: { ...masks, spritePatterns: -1 << 11 },
        interleaved
    };
}

/** Table address masks, named after the shift the V9938 documentation uses. */
const M = {
    NONE: 0,
    B6: -1 << 6,
    B7: -1 << 7,
    B9: -1 << 9,
    B10: -1 << 10,
    B11: -1 << 11,
    B12: -1 << 12,
    B13: -1 << 13,
    B15: -1 << 15,
    B16: -1 << 16
} as const;

export const MODES = {
    T1: mode("T1", 0,  0x10, 256, 192,   2, false, 0,   0,       0, { layout: M.B10, colors: M.NONE, patterns: M.B11, spriteAttributes: M.NONE }),
    T2: mode("T2", 0,  0x12, 512, 212,   4, false, 0,   0,       0, { layout: M.B12, colors: M.B9,   patterns: M.B11, spriteAttributes: M.NONE }),
    MC: mode("MC", 3,  0x08, 256, 192,  16, false, 0,   0,       0, { layout: M.B10, colors: M.NONE, patterns: M.B11, spriteAttributes: M.B7 }),
    G1: mode("G1", 1,  0x00, 256, 192,  16, false, 0,   0,       0, { layout: M.B10, colors: M.B6,   patterns: M.B11, spriteAttributes: M.B7 }),
    G2: mode("G2", 2,  0x01, 256, 192,  16, false, 0,   0,       0, { layout: M.B10, colors: M.B13,  patterns: M.B13, spriteAttributes: M.B7 }),
    G3: mode("G3", 4,  0x02, 256, 192,  16, false, 0,   0,       0, { layout: M.B10, colors: M.B13,  patterns: M.B13, spriteAttributes: M.B10 }),
    G4: mode("G4", 5,  0x03, 256, 212,  16, true,  2, 128,  0x8000, { layout: M.B15, colors: M.NONE, patterns: M.NONE, spriteAttributes: M.B10 }),
    G5: mode("G5", 6,  0x04, 512, 212,   4, true,  4, 128,  0x8000, { layout: M.B15, colors: M.NONE, patterns: M.NONE, spriteAttributes: M.B10 }),
    G6: mode("G6", 7,  0x05, 512, 212,  16, true,  2, 256, 0x10000, { layout: M.B16, colors: M.NONE, patterns: M.NONE, spriteAttributes: M.B10 }, true),
    G7: mode("G7", 8,  0x07, 256, 212, 256, true,  1, 256, 0x10000, { layout: M.B16, colors: M.NONE, patterns: M.NONE, spriteAttributes: M.B10 }, true)
} as const satisfies Record<ScreenModeName, ScreenMode>;

/** The V9938 boot palette: the 16 MSX colours, as 3-bit RGB triples. */
export const DEFAULT_PALETTE: ReadonlyArray<readonly [number, number, number]> = [
    [0, 0, 0], [0, 0, 0], [1, 6, 1], [3, 7, 3],
    [1, 1, 7], [2, 3, 7], [5, 1, 1], [2, 6, 7],
    [7, 1, 1], [7, 3, 3], [6, 6, 1], [6, 6, 4],
    [1, 4, 1], [6, 2, 5], [5, 5, 5], [7, 7, 7]
];

export const VRAM_SIZE = 0x20000;   // 128KB

// --- Colour ---------------------------------------------------------------
//
// The V9938 does not spread its 3-bit components evenly across 0..255, and a
// picture reduced against an even ramp lands slightly off the colours the
// screen actually shows. These are the chip's own levels.

/** 8-bit values of the 3-bit R, G and B components. */
export const LEVELS_3BIT: readonly number[] = [0, 36, 73, 109, 146, 182, 219, 255];

/** 8-bit values of GRAPHIC7's 2-bit blue. Not a scaled copy of the 3-bit ramp. */
export const LEVELS_2BIT: readonly number[] = [0, 73, 146, 255];

/** A palette entry, as the 3-bit components the VDP stores. */
export type PaletteColor = readonly [number, number, number];

/** What a palette entry looks like on screen. */
export function paletteRgb(color: PaletteColor): [number, number, number] {
    return [LEVELS_3BIT[color[0] & 7], LEVELS_3BIT[color[1] & 7], LEVELS_3BIT[color[2] & 7]];
}

/**
 * GRAPHIC7 has no palette: the byte in VRAM is the colour, three bits of
 * green, three of red and two of blue.
 */
export function color256Rgb(byte: number): [number, number, number] {
    return [LEVELS_3BIT[(byte >> 2) & 7], LEVELS_3BIT[(byte >> 5) & 7], LEVELS_2BIT[byte & 3]];
}

/** The GRAPHIC7 byte closest to an 8-bit RGB colour. */
export function rgbToColor256(r: number, g: number, b: number): number {
    return (nearestLevel(LEVELS_3BIT, g) << 5) | (nearestLevel(LEVELS_3BIT, r) << 2) | nearestLevel(LEVELS_2BIT, b);
}

/** The 3-bit palette components closest to an 8-bit RGB colour. */
export function rgbToPalette(r: number, g: number, b: number): PaletteColor {
    return [nearestLevel(LEVELS_3BIT, r), nearestLevel(LEVELS_3BIT, g), nearestLevel(LEVELS_3BIT, b)];
}

/** Index of the entry in `levels` nearest `value`. The ramps are short; a scan is enough. */
function nearestLevel(levels: readonly number[], value: number): number {
    let best = 0;
    let distance = Infinity;
    for (let i = 0; i < levels.length; ++i) {
        const d = Math.abs(levels[i] - value);
        if (d < distance) { distance = d; best = i; }
    }
    return best;
}
