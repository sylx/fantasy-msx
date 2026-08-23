// Typed access to the V9938.
//
// This layer adds names and bookkeeping, not policy. Every method maps onto a
// port write the Z80 would have made, and anything you can do by hand with
// `write()` you can also do through a named helper. Nothing is hidden.
//
// It talks to the chip only through the VdpPorts interface, so the emulator
// underneath can be replaced without touching anything above.

import type { VDP as VdpPorts } from "../core/types.js";
import {
    ARG, CMD, DEFAULT_PALETTE, MODES, OP, R, R0, R1, R8, R9, S, S2,
    type PaletteColor, type ScreenMode, type ScreenModeName
} from "./v9938.js";

/** Where a mode's tables live inside VRAM. Addresses are absolute. */
export interface TableLayout {
    /** Pattern layout table. In bitmap modes this is the framebuffer itself. */
    layout: number;
    colors: number;
    patterns: number;
    /** In sprite mode 2 this is the sprite colour table; attributes follow 512 bytes later. */
    spriteAttributes: number;
    spritePatterns: number;
}

/** The layout MSX-BASIC sets up for a bitmap screen, relative to the page base. */
function defaultBitmapLayout(pageBase: number): TableLayout {
    return {
        layout: pageBase,
        colors: 0,
        patterns: 0,
        spriteAttributes: pageBase + 0x7400,    // colours at +0x7400, attributes at +0x7600
        spritePatterns: pageBase + 0x7800
    };
}

export class Vdp {
    /** The full 128KB of VRAM. Writing here is equivalent to, and much faster than, port writes. */
    readonly vram: Uint8Array;

    readonly cmd: VdpCommands;

    /** Shadow of the control registers, which are write-only on real hardware. */
    private readonly regs = new Uint8Array(47);
    /** Shadow of the 16 palette registers, which are write-only too. */
    private readonly colors: Array<[number, number, number]> = DEFAULT_PALETTE.map((c) => [...c]);
    private currentMode: ScreenMode = MODES.G1;
    private currentPage = 0;
    private layout: TableLayout = defaultBitmapLayout(0);

    constructor(private readonly ports: VdpPorts) {
        this.vram = ports.vram;
        this.cmd = new VdpCommands(this);
    }

    // --- Registers -------------------------------------------------------

    /** Writes a control register through port 0x99. */
    write(reg: number, value: number): void {
        this.regs[reg] = value & 0xff;
        this.ports.output99(value & 0xff);
        this.ports.output99(0x80 | (reg & 0x3f));
    }

    /** Last value written to a control register. The chip cannot be asked. */
    read(reg: number): number {
        return this.regs[reg];
    }

    /** Sets only the bits in `mask`, leaving the rest of the register as it was. */
    writeBits(reg: number, mask: number, value: number): void {
        this.write(reg, (this.regs[reg] & ~mask) | (value & mask));
    }

    /**
     * Writes consecutive registers in one burst through the indirect port 0x9B.
     * Cheaper than repeated `write()` calls, and the only sane way to load the
     * command engine's 15 registers.
     */
    writeBurst(firstReg: number, values: ArrayLike<number>): void {
        this.write(R.INDIRECT_INDEX, firstReg & 0x3f);
        for (let i = 0; i < values.length; ++i) {
            this.regs[(firstReg + i) & 0x3f] = values[i] & 0xff;
            this.ports.output9b(values[i] & 0xff);
        }
        this.regs[R.INDIRECT_INDEX] = (firstReg + values.length) & 0x3f;
    }

    /**
     * Reads a status register. Note the side effects the hardware has:
     * reading S#0 clears the VBlank and collision flags, S#1 clears the line
     * interrupt flag.
     */
    status(reg: number = S.INTERRUPT): number {
        this.write(R.STATUS_SELECT, reg & 0x0f);
        return this.ports.input99();
    }

    // --- Screen mode -----------------------------------------------------

    get mode(): ScreenMode {
        return this.currentMode;
    }

    get page(): number {
        return this.currentPage;
    }

    get tables(): Readonly<TableLayout> {
        return this.layout;
    }

    /**
     * Selects a screen mode and points the tables at `page`.
     *
     * Table addresses follow the layout MSX-BASIC uses, which is a convention
     * rather than a hardware requirement - override it with `setTables()` or by
     * writing R2..R6, R10 and R11 directly.
     *
     * The display geometry that comes with the mode (212 lines versus 192, and
     * the border height that follows from it) only takes effect at the next
     * vertical sync, so the frame during which you switch still uses the old
     * one. Set the mode up before the frame you want it in.
     */
    setMode(name: ScreenModeName, page: number = 0): void {
        const mode = MODES[name];
        this.currentMode = mode;
        this.currentPage = mode.pages ? page % mode.pages : 0;

        this.writeBits(R.MODE_0, R0.MODE_MASK, (mode.bits & 0x07) << 1);
        this.writeBits(R.MODE_1, R1.MODE_MASK, mode.bits & 0x18);
        this.write(R.MODE_3, (this.regs[R.MODE_3] & ~R9.LINES_212) | (mode.height > 192 ? R9.LINES_212 : 0));

        this.setTables(mode.bitmap
            ? defaultBitmapLayout(this.currentPage * mode.pageSize)
            : { layout: 0x1800, colors: 0x2000, patterns: 0x0000, spriteAttributes: 0x1e00, spritePatterns: 0x3800 });
    }

    /**
     * Points the VDP's tables at explicit VRAM addresses.
     *
     * Address bits a mode does not use must still be written as 1s: the VDP
     * ORs them into the mask it applies while fetching, so leaving them at 0
     * masks the fetched address down to the start of VRAM and the screen goes
     * blank. This is why SCREEN 5 sets R2 to 0x1F and SCREEN 2 sets R3 to 0xFF.
     */
    setTables(layout: TableLayout): void {
        this.layout = layout;
        const masks = this.currentMode.tableMasks;

        // G6/G7 split VRAM into even and odd banks, which moves R2's shift.
        const layoutShift = this.currentMode.interleaved ? 11 : 10;
        const layoutWidth = this.currentMode.interleaved ? 0x3f : 0x7f;
        this.write(R.LAYOUT_TABLE, tableRegister(layout.layout, masks.layout, layoutShift, layoutWidth));

        this.write(R.COLOR_TABLE, tableRegister(layout.colors, masks.colors, 6, 0xff));
        this.write(R.COLOR_TABLE_HIGH, tableRegister(layout.colors, masks.colors, 14, 0x07));
        this.write(R.PATTERN_TABLE, tableRegister(layout.patterns, masks.patterns, 11, 0x3f));
        this.write(R.SPRITE_ATTR_TABLE, tableRegister(layout.spriteAttributes, masks.spriteAttributes, 7, 0xff));
        this.write(R.SPRITE_ATTR_TABLE_HIGH, tableRegister(layout.spriteAttributes, masks.spriteAttributes, 15, 0x03));
        this.write(R.SPRITE_PATTERN_TABLE, tableRegister(layout.spritePatterns, masks.spritePatterns, 11, 0x3f));
    }

    /**
     * Moves the pattern layout table - the framebuffer, in a bitmap mode -
     * without disturbing the other tables. This is how a page flip is done.
     */
    setLayoutAddress(address: number): void {
        this.layout = { ...this.layout, layout: address };
        const shift = this.currentMode.interleaved ? 11 : 10;
        const width = this.currentMode.interleaved ? 0x3f : 0x7f;
        this.write(R.LAYOUT_TABLE, tableRegister(address, this.currentMode.tableMasks.layout, shift, width));
    }

    /** Address of the first byte of `line` in the current bitmap page. */
    lineAddress(line: number): number {
        return this.layout.layout + line * this.currentMode.bytesPerLine;
    }

    /** BL. When disabled the VDP shows the backdrop and stops fetching pattern data. */
    setDisplayEnabled(on: boolean): void {
        this.writeBits(R.MODE_1, R1.BLANK, on ? R1.BLANK : 0);
    }

    /** Backdrop, and in text modes the foreground colour too. */
    setBackdrop(color: number): void {
        this.write(R.COLOR, color & 0xff);
    }

    /** 212 lines is the V9938 default; 192 matches MSX1 geometry. */
    setLines(lines: 192 | 212): void {
        this.writeBits(R.MODE_3, R9.LINES_212, lines === 212 ? R9.LINES_212 : 0);
    }

    setSprites(options: { size?: 8 | 16; magnified?: boolean; enabled?: boolean }): void {
        if (options.size !== undefined || options.magnified !== undefined) {
            const size = options.size ?? (this.regs[R.MODE_1] & R1.SPRITE_SIZE ? 16 : 8);
            const mag = options.magnified ?? !!(this.regs[R.MODE_1] & R1.SPRITE_MAG);
            this.writeBits(R.MODE_1, R1.SPRITE_SIZE | R1.SPRITE_MAG,
                (size === 16 ? R1.SPRITE_SIZE : 0) | (mag ? R1.SPRITE_MAG : 0));
        }
        if (options.enabled !== undefined) {
            this.writeBits(R.MODE_2, R8.SPRITE_DISABLE, options.enabled ? 0 : R8.SPRITE_DISABLE);
        }
    }

    /** When false (the hardware default) colour 0 shows the backdrop instead of palette entry 0. */
    setColor0Opaque(opaque: boolean): void {
        this.writeBits(R.MODE_2, R8.TRANSPARENT, opaque ? R8.TRANSPARENT : 0);
    }

    setInterrupts(options: { vertical?: boolean; horizontal?: boolean; line?: number }): void {
        if (options.vertical !== undefined) this.writeBits(R.MODE_1, R1.IE0, options.vertical ? R1.IE0 : 0);
        if (options.horizontal !== undefined) this.writeBits(R.MODE_0, R0.IE1, options.horizontal ? R0.IE1 : 0);
        if (options.line !== undefined) this.write(R.LINE_INTERRUPT, options.line & 0xff);
    }

    /** Scrolls the display vertically by whole lines. Wraps within the page. */
    setVerticalOffset(lines: number): void {
        this.write(R.VERTICAL_OFFSET, lines & 0xff);
    }

    // --- Palette ---------------------------------------------------------

    /**
     * The 16 palette entries as they were last written. The registers are
     * write-only on the chip, so this shadow is the only way to ask what
     * colours are on screen - which is what reducing a picture to them needs.
     */
    get palette(): ReadonlyArray<PaletteColor> {
        return this.colors;
    }

    /** Each component is 3 bits (0-7), giving the V9938's 512-colour space. */
    setPaletteEntry(index: number, r: number, g: number, b: number): void {
        this.colors[index & 0x0f] = [r & 0x07, g & 0x07, b & 0x07];
        this.write(R.PALETTE_INDEX, index & 0x0f);
        this.ports.output9a(((r & 0x07) << 4) | (b & 0x07));
        this.ports.output9a(g & 0x07);
    }

    setPalette(colors: ReadonlyArray<readonly [number, number, number]>): void {
        for (let i = 0; i < colors.length && i < 16; ++i) {
            this.setPaletteEntry(i, colors[i][0], colors[i][1], colors[i][2]);
        }
    }

    resetPalette(): void {
        this.setPalette(DEFAULT_PALETTE);
    }

    // --- VRAM through the ports -------------------------------------------

    /**
     * Points the VRAM pointer at `address` for writing. Only needed for the
     * port-based path; direct access through `vram` is faster and unrestricted.
     */
    setWriteAddress(address: number): void {
        this.write(R.VRAM_ADDRESS_HIGH, (address >> 14) & 0x07);
        this.ports.output99(address & 0xff);
        this.ports.output99(0x40 | ((address >> 8) & 0x3f));
    }

    setReadAddress(address: number): void {
        this.write(R.VRAM_ADDRESS_HIGH, (address >> 14) & 0x07);
        this.ports.output99(address & 0xff);
        this.ports.output99((address >> 8) & 0x3f);
    }

    /** Writes one byte at the VRAM pointer and advances it. */
    writeData(value: number): void {
        this.ports.output98(value & 0xff);
    }

    /** Reads one byte at the VRAM pointer and advances it. */
    readData(): number {
        return this.ports.input98();
    }

    // --- Lifecycle -------------------------------------------------------

    reset(): void {
        this.ports.reset();
        this.regs.fill(0);
        // The chip reloads its boot palette on reset; keep the shadow in step.
        for (let i = 0; i < 16; ++i) this.colors[i] = [...DEFAULT_PALETTE[i]];
        this.currentMode = MODES.G1;
        this.currentPage = 0;
    }
}

/**
 * The V9938's blitter.
 *
 * Commands do not complete instantly: the chip works through them over the
 * following scanlines, and `busy` stays true until it is done. Issuing a new
 * command while one is running aborts the old one, so check `busy` (or let a
 * frame elapse) between them.
 */
/**
 * Builds a table base register: the significant address bits taken from
 * `address`, and every bit the mode ignores forced to 1.
 */
function tableRegister(address: number, addressMask: number, shift: number, registerMask: number): number {
    const significant = (addressMask >>> shift) & registerMask;
    return ((address >>> shift) & significant) | (~significant & registerMask);
}

export class VdpCommands {
    /** Scratch for the R32..R46 burst, reused to keep the hot path allocation-free. */
    private readonly args = new Uint8Array(15);

    constructor(private readonly vdp: Vdp) {}

    /** CE: true while the command engine is still working. */
    get busy(): boolean {
        return (this.vdp.status(S.COMMAND) & S2.COMMAND_EXECUTING) !== 0;
    }

    /** Byte read back by POINT and LMCM. */
    get color(): number {
        return this.vdp.status(S.COLOR);
    }

    stop(): void {
        this.vdp.write(R.CMD, CMD.STOP);
    }

    /** Fills a rectangle in pixel coordinates. */
    fill(x: number, y: number, width: number, height: number, color: number, op: number = OP.IMP, direction = 0): void {
        this.execute(0, 0, x, y, width, height, color, direction, CMD.LMMV | op);
    }

    /** Copies a rectangle within VRAM, in pixel coordinates. */
    copy(sx: number, sy: number, dx: number, dy: number, width: number, height: number, op: number = OP.IMP, direction = 0): void {
        this.execute(sx, sy, dx, dy, width, height, 0, direction, CMD.LMMM | op);
    }

    /**
     * Fills a rectangle in byte coordinates. Faster than `fill` because the
     * chip moves whole bytes, but x and width are in bytes, so the granularity
     * is the mode's pixels-per-byte and `color` must hold every pixel of a byte.
     */
    fillBytes(x: number, y: number, width: number, height: number, color: number, direction = 0): void {
        this.execute(0, 0, x, y, width, height, color, direction, CMD.HMMV);
    }

    /** Copies a rectangle within VRAM in byte coordinates. The fastest blit the chip has. */
    copyBytes(sx: number, sy: number, dx: number, dy: number, width: number, height: number, direction = 0): void {
        this.execute(sx, sy, dx, dy, width, height, 0, direction, CMD.HMMM);
    }

    /**
     * Draws a line from (x, y). `major` is the length along the long axis and
     * `minor` along the short one; set `ARG.MAJOR_Y` in `direction` to make Y
     * the long axis, and `ARG.LEFT` / `ARG.UP` to choose the quadrant.
     */
    line(x: number, y: number, major: number, minor: number, color: number, direction = 0, op: number = OP.IMP): void {
        this.execute(0, 0, x, y, major, minor, color, direction, CMD.LINE | op);
    }

    /** Draws a line between two points, working out the direction flags. */
    lineTo(x0: number, y0: number, x1: number, y1: number, color: number, op: number = OP.IMP): void {
        const dx = x1 - x0;
        const dy = y1 - y0;
        const ax = Math.abs(dx);
        const ay = Math.abs(dy);
        const majorY = ay > ax;
        const direction = (majorY ? ARG.MAJOR_Y : 0) | (dx < 0 ? ARG.LEFT : 0) | (dy < 0 ? ARG.UP : 0);
        this.line(x0, y0, majorY ? ay : ax, majorY ? ax : ay, color, direction, op);
    }

    pset(x: number, y: number, color: number, op: number = OP.IMP): void {
        this.execute(0, 0, x, y, 0, 0, color, 0, CMD.PSET | op);
    }

    /** Starts a read of one pixel. The value lands in `color` once `busy` clears. */
    point(x: number, y: number): void {
        this.execute(x, y, 0, 0, 0, 0, 0, 0, CMD.POINT);
    }

    /** Scans right (or left) along a line for a pixel matching `color`. Result in S#8/S#9. */
    search(x: number, y: number, color: number, direction = 0): void {
        this.execute(x, y, 0, 0, 0, 0, color, direction, CMD.SRCH);
    }

    /** Loads R32..R46 and starts the command. */
    execute(sx: number, sy: number, dx: number, dy: number, nx: number, ny: number, color: number, arg: number, command: number): void {
        const a = this.args;
        a[0]  = sx;         a[1]  = (sx >> 8) & 0x01;
        a[2]  = sy;         a[3]  = (sy >> 8) & 0x03;
        a[4]  = dx;         a[5]  = (dx >> 8) & 0x01;
        a[6]  = dy;         a[7]  = (dy >> 8) & 0x03;
        a[8]  = nx;         a[9]  = (nx >> 8) & 0x01;
        a[10] = ny;         a[11] = (ny >> 8) & 0x03;
        a[12] = color;
        a[13] = arg;
        a[14] = command;
        this.vdp.writeBurst(R.SX, a);
    }
}
