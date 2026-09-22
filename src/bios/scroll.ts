// Scrolling: the display as a window onto a plane, moved by registers.
//
// A V9938 scrolls one way. R23 says which line of the page the display starts
// on, and the page wraps at 256 lines whatever the screen height, so the
// picture is a window 212 lines tall onto a loop 256 lines round. The V9958
// adds the other axis: R26 and R27 say which column the display starts on,
// and R25's SP2 lets that run across two pages side by side - a plane 512
// pixels wide. Either way nothing in VRAM moves. A scroll costs a few register
// writes, which is why the MSX2+ could do what the MSX2 needed the blitter for.
//
// What this adds is bands. The registers are read as each line is drawn, so
// changing them partway down the frame gives the lines below different values
// from the lines above: a status bar that holds still over a playfield that
// does not, hills that move at half the speed of the ground in front of them.
// On the real machine that is a line interrupt and a handler that rewrites the
// registers in the time between two lines, and it is exactly that here - R19
// is armed for the line before each band, and the handler runs in the CPU's
// time slice at the end of it.
//
// Sprites are composited by the same raster, so R23 moves them along with the
// picture. `Sprites` takes its offsets from here and writes Y already
// corrected, so a sprite placed at a screen line appears on that line; one
// that straddles two bands with different offsets is torn between them, as it
// is on the hardware. Worse, a sprite whose page line comes round into another
// band's lines turns up there too - a ghost in the status bar. So a band can
// turn sprites off for its lines, which the handler does with R8's SPD bit
// the same way it does the scroll: `split(0, { sprites: false })`.

import { S, S1, type Vdp } from "../api/index.js";
import { isPatternMode, type Screen } from "./screen.js";

/** Lines round the plane, whatever the screen height: R23 is eight bits. */
export const PLANE_HEIGHT = 256;

/** One horizontal strip of the screen, and where it looks into the plane. */
export interface ScrollBand {
    /** First screen line the band covers. It runs down to the next band. */
    readonly top: number;
    /** Plane column at the left edge. In the 512-wide modes it moves in steps of two. */
    x: number;
    /** Plane line at the top of the screen - not of the band. The same meaning R23 has. */
    y: number;
    /**
     * Page the band shows. Left out, it follows `screen.displayPage`. With
     * `wide` on, a page stands for the pair it belongs to: 0 and 1, 2 and 3.
     */
    page?: number;
    /**
     * False hides every sprite on the band's lines (R8's SPD, switched on the
     * line interrupt). A status bar over a scrolling field wants it: otherwise
     * a sprite whose page line comes round into the bar's lines shows up there
     * too. A sprite reaching into such a band from one that shows sprites is
     * placed against the band that shows it, so it slides in cleanly. Left out,
     * sprites show as `sprites.setEnabled` has them.
     */
    sprites?: boolean;
}

export interface BandOptions {
    x?: number;
    y?: number;
    page?: number;
    sprites?: boolean;
}

export class Scroll {
    private readonly list: ScrollBand[] = [{ top: 0, x: 0, y: 0 }];
    private masked = false;
    private twoPages = false;
    /** Index of the band the next line interrupt brings in. */
    private next = 1;
    /** R23 as last written, which the line interrupt is compared against. */
    private offset = 0;
    /**
     * Nothing is written until the scroll is first used, so a program setting
     * R23 or R26 by hand is not overwritten at every vertical sync.
     */
    private engaged = false;
    /** What `sprites.setEnabled` last asked for. Bands can only take sprites away. */
    private spritesWanted = true;
    /** Whether the last band applied had R8's SPD in its charge. */
    private ownsSprites = false;

    constructor(private readonly vdp: Vdp, private readonly screen: Screen) {}

    // --- The whole screen ---------------------------------------------------

    /** Plane column at the left edge of the top band. */
    get x(): number {
        return this.list[0].x;
    }

    set x(value: number) {
        this.list[0].x = value;
        this.engaged = true;
    }

    /** Plane line at the top of the screen, in the top band. */
    get y(): number {
        return this.list[0].y;
    }

    set y(value: number) {
        this.list[0].y = value;
        this.engaged = true;
    }

    /** Moves the top band. Without splits that is the whole screen. */
    set(x: number, y: number): void {
        this.list[0].x = x;
        this.list[0].y = y;
        this.engaged = true;
    }

    /**
     * R25's MSK: blanks the leftmost 8 pixels. A fine horizontal scroll shifts
     * the picture right by up to seven pixels and shows the backdrop in the gap,
     * so without this the left edge visibly flutters as the scroll moves.
     */
    get mask(): boolean {
        return this.masked;
    }

    set mask(on: boolean) {
        this.masked = on;
        this.engaged = true;
        this.vdp.setScrollMode({ mask: on });
    }

    /**
     * R25's SP2: the horizontal scroll runs across two pages, an even one on
     * the left and the odd one after it on the right. The plane doubles to
     * `2 * screen.width`, and the display has to be pointed at the odd page of
     * the pair, which is done for you. A bitmap mode needs two pages for it, so
     * SCREEN 7 and 8 give up double buffering.
     */
    get wide(): boolean {
        return this.twoPages;
    }

    set wide(on: boolean) {
        this.twoPages = on;
        this.engaged = true;
        this.vdp.setScrollMode({ twoPages: on });
    }

    /** How far x goes before it wraps. */
    get planeWidth(): number {
        return this.screen.width * (this.twoPages ? 2 : 1);
    }

    /** How far y goes before it wraps: 256, whatever the screen height. */
    get planeHeight(): number {
        return PLANE_HEIGHT;
    }

    // --- Bands --------------------------------------------------------------

    /** Top first. There is always at least the one starting at line 0. */
    get bands(): readonly ScrollBand[] {
        return this.list;
    }

    /**
     * Starts a band at screen line `top`, running down to the next one, and
     * hands it back to be moved from then on. A band already starting on that
     * line is reused. Every split costs a line interrupt a frame, and nothing
     * stops you putting one on every line.
     *
     *     const hud = scroll.split(0, { page: 1 });     // held still
     *     const field = scroll.split(24);                // moved every frame
     *     field.x = camera.x;
     */
    split(top: number, options: BandOptions = {}): ScrollBand {
        top = Math.max(0, Math.min(PLANE_HEIGHT - 1, Math.round(top)));
        let band = this.list.find((b) => b.top === top);
        if (!band) {
            band = { top, x: this.x, y: this.y };
            this.list.push(band);
            this.list.sort((a, b) => a.top - b.top);
        }
        if (options.x !== undefined) band.x = options.x;
        if (options.y !== undefined) band.y = options.y;
        if (options.page !== undefined) band.page = options.page;
        if (options.sprites !== undefined) band.sprites = options.sprites;
        this.engaged = true;
        return band;
    }

    /** Removes one band, or with no argument every band but the top one. */
    unsplit(band?: ScrollBand): void {
        if (band === undefined) {
            this.list.length = 1;
        } else if (band.top !== 0) {
            const i = this.list.indexOf(band);
            if (i > 0) this.list.splice(i, 1);
        }
    }

    /** The band covering a screen line. */
    at(line: number): ScrollBand {
        let band = this.list[0];
        for (let i = 1; i < this.list.length && this.list[i].top <= line; ++i) band = this.list[i];
        return band;
    }

    /**
     * The band a sprite `height` lines tall with its top on screen line `line`
     * is written against: the one covering its top line, unless that band hides
     * sprites - then the first band further down that shows them and begins
     * within the sprite, so its lower part is drawn in the right place there.
     * Null when the sprite lies wholly in bands that hide sprites: written
     * against one of those it would be a ghost in some other band, so it is
     * parked instead.
     */
    spriteBand(line: number, height: number): ScrollBand | null {
        const band = this.at(line);
        if (band.sprites !== false) return band;
        for (const below of this.list) {
            if (below.top > line && below.top < line + height && below.sprites !== false) return below;
        }
        return null;
    }

    /** Where a screen pixel is in the plane, through whichever band covers it. */
    toPlane(x: number, y: number): { x: number; y: number } {
        const band = this.at(y);
        return {
            x: wrap(x + band.x, this.planeWidth),
            y: wrap(y + band.y, PLANE_HEIGHT)
        };
    }

    /**
     * The first of `height` page lines that no band shows sprites on -
     * somewhere a sprite can be parked without turning up in some other band.
     * Looks from just below the bottom band onwards, and skips 208 and 216,
     * which as a sprite's Y would end the sprite list.
     */
    unseenLine(height: number): number {
        const lines = this.screen.height;
        const shown = new Uint8Array(PLANE_HEIGHT);
        for (let i = 0; i < this.list.length; ++i) {
            const band = this.list[i];
            if (band.sprites === false) continue;
            const end = Math.min(lines, this.list[i + 1]?.top ?? lines);
            for (let line = band.top; line < end; ++line) shown[(line + band.y) & 0xff] = 1;
        }
        const start = (lines + 2 + this.at(lines - 1).y) & 0xff;
        for (let k = 0; k < PLANE_HEIGHT; ++k) {
            const first = (start + k) & 0xff;
            const stored = (first - 1) & 0xff;
            if (stored === 208 || stored === 216) continue;
            let free = true;
            for (let d = 0; d < height && free; ++d) free = shown[(first + d) & 0xff] === 0;
            if (free) return first;
        }
        return start;
    }

    // --- The raster ---------------------------------------------------------

    /** Whether the scroll has been used, and so owns R23, R26, R27 and R19. */
    get active(): boolean {
        return this.engaged;
    }

    /**
     * Whether sprites are wanted at all, for the bands to take away from.
     * `sprites.setEnabled` calls this; call that instead.
     * @internal
     */
    setSpritesEnabled(on: boolean): void {
        this.spritesWanted = on;
        this.vdp.setSprites({ enabled: on });
    }

    /**
     * Loads the top band and arms the interrupt for the next. The BIOS calls
     * this at the vertical sync, before the frame's first line.
     */
    vsync(): void {
        if (!this.engaged) return;
        this.next = 1;
        this.apply(this.list[0]);
        this.arm();
        // A line interrupt from the bottom of the last frame could still be
        // pending. Reading S#1 drops it, so the first band is not cut short.
        if (this.list.length > 1) this.vdp.status(S.STATUS);
    }

    /** The line interrupt. The BIOS installs this as the machine's handler. */
    interrupt(): void {
        // Reading S#1 is the acknowledgement; without it the line stays low.
        if ((this.vdp.status(S.STATUS) & S1.LINE_INTERRUPT) === 0) return;
        const band = this.list[this.next++];
        if (band) this.apply(band);
        this.arm();
    }

    private apply(band: ScrollBand): void {
        this.offset = band.y & 0xff;
        this.vdp.setVerticalOffset(this.offset);
        this.vdp.setHorizontalOffset(Math.round(band.x * 256 / this.screen.width));

        // R8's SPD is left alone unless a band hides sprites - and put back the
        // once when the last such band goes, so it does not stay off.
        const hiding = this.list.some((b) => b.sprites === false);
        if (hiding || this.ownsSprites) {
            this.vdp.setSprites({ enabled: this.spritesWanted && band.sprites !== false });
            this.ownsSprites = hiding;
        }

        // R2 is left alone unless something asks for a page. In SCREEN 1, 2
        // and 4 a page is a name table, which flips the same way; in the
        // other character modes R2 is whatever the program made it.
        const paged = this.screen.mode.bitmap || isPatternMode(this.screen.mode.name);
        if (paged && (this.twoPages || this.list.some((b) => b.page !== undefined))) {
            const page = band.page ?? this.screen.displayPage;
            this.vdp.setLayoutAddress(this.screen.pageBase(this.twoPages ? page | 1 : page));
        }
    }

    private arm(): void {
        const band = this.list[this.next];
        if (!band) {
            this.vdp.setInterrupts({ horizontal: false });
            return;
        }
        // The interrupt fires at the end of the line R19 names, counted the way
        // R23 has already shifted them, which leaves the handler the rest of
        // that line to set up the next one.
        this.vdp.setInterrupts({ horizontal: true, line: (band.top - 1 + this.offset) & 0xff });
    }
}

function wrap(value: number, size: number): number {
    return ((value % size) + size) % size;
}
