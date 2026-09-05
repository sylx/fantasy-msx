// One tick is one second. Terrain and ecology share a seeded random source,
// so a visit can still be reproduced headlessly with the same island seed.
export interface Plot {
    x: number;
    y: number;
    pond: boolean;
    variant: number;
    age: number;                       // 0 empty, 1 seed, 2..3 shoot, 4 mature
    water: number;
    stress: number;
    lifetime: number;
    dry: number;
    dead: number;                      // seconds until the snag returns to soil
    compost: number;                   // decaying wood retains moisture
}

export interface Bird {
    tree: Plot;
    drop: Plot | undefined;
    phase: number;                     // arrive 0..2, perch 2..4, sow 6, leave 8
    fromLeft: boolean;
}

export class Garden {
    readonly plots: Plot[] = [];
    seconds = 0;
    rain = 0;
    bird: Bird | null = null;
    seedsDelivered = 0;
    private randomState: number;
    private nextBird: number;

    constructor(readonly seed = 1988) {
        this.randomState = seed >>> 0;
        const phase = this.random() * Math.PI * 2;
        const stretch = 0.8 + this.random() * 0.4;
        for (let y = 0; y < 11; ++y) {
            for (let x = 0; x < 11; ++x) {
                const dx = (x - 5) * stretch, dy = (y - 5) / stretch;
                const angle = Math.atan2(dy, dx);
                const radius = 4.5 + Math.sin(angle * 3 + phase) * 0.8 + Math.cos(angle * 2 - phase) * 0.5;
                if (Math.hypot(dx, dy) > radius) continue;
                this.plots.push({ x, y, pond: false, variant: Math.floor(this.random() * 3),
                    age: 0, water: 0, stress: 0, lifetime: 0, dry: 0, dead: 0, compost: 0 });
            }
        }
        // Keep only ground connected to the centre by the controller's axes.
        const connected = new Set<Plot>([this.at(5, 5)!]);
        for (const plot of connected) for (const other of this.plots) {
            if (distance(plot, other) === 1) connected.add(other);
        }
        for (let i = this.plots.length - 1; i >= 0; --i) {
            if (!connected.has(this.plots[i])) this.plots.splice(i, 1);
        }
        const interior = this.plots.filter(plot => (plot.x - 5) ** 2 + (plot.y - 5) ** 2 < 9);
        const pond = interior[Math.floor(this.random() * interior.length)];
        const radius = 1 + this.random() * 0.7;
        for (const plot of this.plots) {
            plot.pond = Math.hypot(plot.x - pond.x, plot.y - pond.y) <= radius;
        }
        // A stream joins the pond to the island's edge.
        const alongX = this.random() > 0.5;
        let outlet: Plot | undefined = pond;
        while (outlet) {
            outlet.pond = true;
            outlet = this.at(outlet.x + Number(alongX), outlet.y + Number(!alongX));
        }
        for (const plot of this.plots) if (plot.pond) plot.water = 8;
        for (let i = 0; i < 5; ++i) {
            const empty = this.plots.filter(plot => !plot.pond && !plot.age
                && !this.mature.some(tree => distance(plot, tree) < 2));
            if (!empty.length) break;
            const tree = empty[Math.floor(this.random() * empty.length)];
            tree.age = 4;
            tree.lifetime = Math.floor(this.random() * 20);
        }
        this.nextBird = 10 + Math.floor(this.random() * 7);
    }

    private random(): number {
        this.randomState = (Math.imul(this.randomState, 1664525) + 1013904223) >>> 0;
        return this.randomState / 0x100000000;
    }

    at(x: number, y: number): Plot | undefined {
        return this.plots.find(plot => plot.x === x && plot.y === y);
    }

    get mature(): Plot[] { return this.plots.filter(plot => plot.age === 4); }
    get planted(): number { return this.plots.filter(plot => plot.age > 0).length; }

    plant(plot: Plot): boolean {
        if (plot.pond || plot.age !== 0 || plot.dead) return false;
        plot.age = 1;
        plot.stress = plot.lifetime = plot.dry = 0;
        return true;
    }

    /** Thinning gives neighbouring crowns room; clearing a snag makes soil. */
    clear(plot: Plot): boolean {
        if (!plot.age && !plot.dead) return false;
        plot.age = plot.dead = plot.stress = plot.lifetime = plot.dry = 0;
        plot.compost = 18;
        plot.water = Math.max(plot.water, 4);
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
        // Snapshot living crowns, so one death cannot relieve the next tree in
        // iteration order. Seedlings do not compete until their crowns mature.
        const parents = this.mature;
        for (const plot of this.plots) {
            if (plot.pond) continue;
            const before = `${plot.age},${plot.water > 0},${plot.stress >= 4},${plot.dead > 0},${plot.compost > 0}`;
            if (this.rain || this.plots.some(other => other.pond && distance(plot, other) === 1)) plot.water = 8;
            if (plot.dead) {
                if (--plot.dead === 0) this.clearSnag(plot);
            } else if (plot.age > 0 && plot.age < 4 && plot.water > 0) {
                ++plot.age;
            } else if (plot.age === 4) {
                ++plot.lifetime;
                plot.dry = plot.water ? 0 : plot.dry + 1;
                const crowded = parents.filter(other => other !== plot
                    && Math.max(Math.abs(plot.x - other.x), Math.abs(plot.y - other.y)) <= 1).length >= 5;
                plot.stress = Math.max(0, plot.stress + (crowded ? 2 : plot.dry > 14 ? 1 : -2));
                const lifespan = 55 + plot.variant * 13 + (plot.x * 7 + plot.y * 11) % 19;
                if (plot.stress >= 10 || plot.lifetime >= lifespan) {
                    plot.age = 0;
                    plot.dead = 6 + plot.variant;
                }
            }
            if (!plot.compost || this.seconds % 2 === 0) plot.water = Math.max(0, plot.water - 1);
            plot.compost = Math.max(0, plot.compost - 1);
            const after = `${plot.age},${plot.water > 0},${plot.stress >= 4},${plot.dead > 0},${plot.compost > 0}`;
            if (before !== after) changed = true;
        }
        if (this.seconds % 4 === 0) for (const parent of parents) {
            if (parent.age !== 4 || parent.stress >= 4 || this.random() > 0.45) continue;
            const neighbours = this.plots.filter(plot => !plot.pond && !plot.age && !plot.dead && plot.water > 0
                && distance(plot, parent) === 1);
            if (neighbours.length) {
                this.plant(neighbours[Math.floor(this.random() * neighbours.length)]);
                changed = true;
            }
        }
        return this.visit() || changed;
    }

    private clearSnag(plot: Plot): void {
        plot.stress = plot.lifetime = plot.dry = 0;
        plot.compost = 18;
        plot.water = Math.max(plot.water, 4);
    }

    private visit(): boolean {
        if (this.bird) {
            ++this.bird.phase;
            if (this.bird.phase === 6 && this.bird.drop && this.plant(this.bird.drop)) {
                ++this.seedsDelivered;
                return true;
            }
            if (this.bird.phase >= 8) this.bird = null;
        } else if (this.seconds >= this.nextBird) {
            this.nextBird = this.seconds + 18 + Math.floor(this.random() * 13);
            const trees = this.mature.filter(plot => plot.stress < 4);
            if (trees.length && !this.rain) {
                const tree = trees[Math.floor(this.random() * trees.length)];
                const empty = this.plots.filter(plot => !plot.pond && !plot.age && !plot.dead && distance(plot, tree) >= 3);
                this.bird = { tree, drop: empty[Math.floor(this.random() * empty.length)], phase: 0,
                    fromLeft: this.random() > 0.5 };
            }
        }
        return false;
    }
}

function distance(a: Plot, b: Plot): number { return Math.abs(a.x - b.x) + Math.abs(a.y - b.y); }

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
