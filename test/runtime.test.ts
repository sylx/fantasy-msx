import { describe, expect, it, vi } from "vitest";
import { BUTTON, boot, HeadlessHost, Input, type App, type Context } from "../src/index.js";
import { game } from "../examples/game.js";

describe("Runtime", () => {
    it("runs init once, then update and draw every frame", () => {
        const calls: string[] = [];
        const app: App = {
            init: () => calls.push("init"),
            update: () => calls.push("update"),
            draw: () => calls.push("draw")
        };

        const runtime = boot();
        runtime.run(app);
        expect(calls).toEqual(["init"]);

        runtime.step(2);
        expect(calls).toEqual(["init", "update", "draw", "update", "draw"]);
    });

    it("counts frames and seconds", () => {
        const runtime = boot();
        runtime.run({ update: () => {} });
        expect(runtime.frame).toBe(0);

        runtime.step(60);
        expect(runtime.frame).toBe(60);
        expect(runtime.time).toBeCloseTo(1);
    });

    it("hands every frame to the host", () => {
        const host = new HeadlessHost();
        const runtime = boot({ host });
        runtime.run({ update: () => {} });
        expect(host.frame).toBeNull();

        runtime.step();
        expect(host.frame).not.toBeNull();
        expect(host.frame!.width).toBeGreaterThan(0);
    });

    it("works without a draw function", () => {
        const runtime = boot();
        const update = vi.fn();
        runtime.run({ update });
        runtime.step(3);
        expect(update).toHaveBeenCalledTimes(3);
    });

    it("advances the blitter as frames go by", () => {
        const runtime = boot();
        runtime.run({
            init: ({ gfx }: Context) => { gfx.now.clear(0); gfx.clear(9); },
            update: () => {}
        });

        expect(runtime.gfx.busy).toBe(true);
        runtime.step(1);
        expect(runtime.gfx.work).toBeGreaterThan(0);
        expect(runtime.gfx.work).toBeLessThan(256 * 212);

        runtime.step(5);
        expect(runtime.gfx.busy).toBe(false);
    });
});

describe("Input", () => {
    it("reports a press as new on the frame after it happens", () => {
        const runtime = boot();
        const seen: Array<{ held: boolean; pressed: boolean }> = [];
        runtime.run({
            update: ({ input }: Context) => seen.push({ held: input.btn(BUTTON.A), pressed: input.btnp(BUTTON.A) })
        });

        runtime.input.setButton(BUTTON.A, true);
        runtime.step(2);                            // pressed, then still held
        runtime.input.setButton(BUTTON.A, false);
        runtime.step(1);

        expect(seen).toEqual([
            { held: true, pressed: true },
            { held: true, pressed: false },
            { held: false, pressed: false }
        ]);
    });

    it("reports a release", () => {
        const input = new Input();
        input.setButton(BUTTON.B, true);
        input.latch();
        input.setButton(BUTTON.B, false);
        expect(input.btnr(BUTTON.B)).toBe(true);
        input.latch();
        expect(input.btnr(BUTTON.B)).toBe(false);
    });

    it("keeps the two players apart", () => {
        const input = new Input();
        input.setButton(BUTTON.LEFT, true, 1);
        expect(input.btn(BUTTON.LEFT, 1)).toBe(true);
        expect(input.btn(BUTTON.LEFT, 0)).toBe(false);
    });

    it("collapses the directions into an axis", () => {
        const input = new Input();
        expect(input.axis()).toEqual({ x: 0, y: 0 });
        input.setButton(BUTTON.LEFT, true);
        input.setButton(BUTTON.DOWN, true);
        expect(input.axis()).toEqual({ x: -1, y: 1 });
        input.setButton(BUTTON.RIGHT, true);        // both directions cancel
        expect(input.axis()).toEqual({ x: 0, y: 1 });
    });

    it("maps bound keys to buttons and leaves the rest alone", () => {
        const input = new Input();
        expect(input.setKey("ArrowLeft", true)).toBe(true);
        expect(input.btn(BUTTON.LEFT)).toBe(true);

        expect(input.setKey("Escape", true)).toBe(false);
        expect(input.key("Escape")).toBe(true);
        expect(input.keyp("Escape")).toBe(true);
        input.latch();
        expect(input.keyp("Escape")).toBe(false);
    });

    it("takes a different key map", () => {
        const input = new Input();
        input.setKeyMap([{ Space: BUTTON.A }]);
        expect(input.setKey("ArrowLeft", true)).toBe(false);
        expect(input.btn(BUTTON.LEFT)).toBe(false);
        expect(input.setKey("Space", true)).toBe(true);
        expect(input.btn(BUTTON.A)).toBe(true);
    });

    it("lets go of everything when focus is lost", () => {
        const input = new Input();
        input.setKey("ArrowUp", true);
        input.releaseAll();
        expect(input.btn(BUTTON.UP)).toBe(false);
        expect(input.key("ArrowUp")).toBe(false);
    });
});

describe("the example game", () => {
    it("moves its sprite with the controller and queues work with the trigger", () => {
        const runtime = boot();
        runtime.run(game);
        const attributes = runtime.bios.system.vdp.vram;
        const spriteX = () => attributes[0x07600 + 1];

        const before = spriteX();
        runtime.input.setButton(BUTTON.LEFT, true);
        runtime.step(10);
        runtime.input.setButton(BUTTON.LEFT, false);
        expect(spriteX()).toBeLessThan(before);

        while (runtime.gfx.busy) runtime.step();
        const quiet = runtime.gfx.getPixel(spriteX() + 8, 158);

        runtime.input.setButton(BUTTON.A, true);
        runtime.step(1);
        runtime.input.setButton(BUTTON.A, false);
        while (runtime.gfx.busy) runtime.step();

        // A bloom is painted in palette 8 or 9, over whatever the sky was.
        const painted = runtime.gfx.getPixel(spriteX() + 8, 158);
        expect(painted).not.toBe(quiet);
        expect(painted).toBeGreaterThanOrEqual(8);
    });
});
