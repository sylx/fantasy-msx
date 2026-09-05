// The world knows nothing about VRAM or the host. One tick is one second;
// a fixed seed makes the same garden reproducible in the browser and in a tool.
export interface Plot {
    x: number;
    y: number;
    pond: boolean;
    variant: number;
    age: number;                       // 0 empty, 1 seed, 2..3 shoot, 4 mature
    water: number;
}

export class Garden {
    readonly plots: Plot[] = [];
    seconds = 0;
    rain = 0;
    private randomState = 1988;

    constructor() {
        for (let y = 0; y < 11; ++y) {
            for (let x = 0; x < 11; ++x) {
                if ((x - 5) ** 2 + (y - 5) ** 2 > 28) continue;
                const pond = (x - 6) ** 2 + (y - 3) ** 2 < 4;
                const mature = !pond && ((x === 2 && y % 2 === 0) || (y === 2 && x === 4));
                this.plots.push({ x, y, pond, variant: Math.floor(this.random() * 3),
                    age: mature ? 4 : 0, water: pond ? 8 : 0 });
            }
        }
    }

    private random(): number {
        this.randomState = (Math.imul(this.randomState, 1664525) + 1013904223) >>> 0;
        return this.randomState / 0x100000000;
    }

    at(x: number, y: number): Plot | undefined {
        return this.plots.find(plot => plot.x === x && plot.y === y);
    }

    get mature(): Plot[] { return this.plots.filter(plot => plot.age >= 4); }
    get planted(): number { return this.plots.filter(plot => plot.age > 0).length; }

    plant(plot: Plot): boolean {
        if (plot.pond || plot.age !== 0) return false;
        plot.age = 1;
        return true;
    }

    shower(): void {
        this.rain = 6;
        for (const plot of this.plots) plot.water = 8;
    }

    /** True only when the landscape's pixels need to change. */
    tick(): boolean {
        let changed = false;
        ++this.seconds;
        this.rain = Math.max(0, this.rain - 1);
        // Snapshot the parents: a seed born this tick cannot spread this tick.
        const parents = this.mature;
        for (const plot of this.plots) {
            if (plot.pond) continue;
            const age = plot.age, wet = plot.water > 0;
            const nearWater = this.plots.some(other => other.pond
                && Math.abs(plot.x - other.x) + Math.abs(plot.y - other.y) === 1);
            if (this.rain || nearWater) plot.water = 8;
            if (plot.age > 0 && plot.age < 4 && plot.water > 0) ++plot.age;
            plot.water = Math.max(0, plot.water - 1);
            if (age !== plot.age || wet !== (plot.water > 0)) changed = true;
        }
        if (this.seconds % 4 !== 0) return changed;
        for (const parent of parents) {
            if (this.random() > 0.45) continue;
            const neighbours = this.plots.filter(plot => !plot.pond && !plot.age && plot.water > 0
                && Math.abs(plot.x - parent.x) + Math.abs(plot.y - parent.y) === 1);
            if (neighbours.length) {
                this.plant(neighbours[Math.floor(this.random() * neighbours.length)]);
                changed = true;
            }
        }
        return changed;
    }
}

export function position(plot: Pick<Plot, "x" | "y">): { x: number; y: number } {
    return { x: 128 + (plot.x - plot.y) * 10, y: 54 + (plot.x + plot.y) * 5 };
}

/** Pick the ground diamond, even when a canopy covers it. */
export function pick(garden: Garden, x: number, y: number): Plot | undefined {
    return garden.plots.find(plot => {
        const p = position(plot);
        return Math.abs(x - p.x) / 10 + Math.abs(y - p.y) / 5 <= 1;
    });
}
