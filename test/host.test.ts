// The browser host, driven against a canvas and a window made of nothing.
//
// Node has no DOM, so the events are delivered by hand - which is the point:
// it is the wiring between a drag and `runtime.drop` that is worth pinning
// down, and there is no browser here to do it in.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserHost, boot, type App, type DroppedFile } from "../src/index.js";

type Handler = (event: unknown) => void;

/** An element that remembers what was bound to it and will fire it on demand. */
function element() {
    const handlers = new Map<string, Set<Handler>>();
    return {
        width: 256,
        height: 212,
        dataset: {} as Record<string, string | undefined>,
        /** Where the page put the canvas, and at what size CSS is showing it. */
        rect: { left: 0, top: 0, width: 256, height: 212 },
        captured: new Set<number>(),
        getContext: () => ({ imageSmoothingEnabled: false, fillRect() {}, drawImage() {} }),
        getBoundingClientRect() { return this.rect; },
        setPointerCapture(id: number) { this.captured.add(id); },
        releasePointerCapture(id: number) { this.captured.delete(id); },
        addEventListener(type: string, handler: Handler) {
            (handlers.get(type) ?? handlers.set(type, new Set()).get(type)!).add(handler);
        },
        removeEventListener(type: string, handler: Handler) {
            handlers.get(type)?.delete(handler);
        },
        fire(type: string, event: unknown) {
            for (const handler of [...(handlers.get(type) ?? [])]) handler(event);
        },
        get bound(): number {
            let n = 0;
            for (const set of handlers.values()) n += set.size;
            return n;
        }
    };
}

/** A pointer event, as the browser would present it. */
function pointer(clientX: number, clientY: number, button = 0) {
    return { clientX, clientY, button, pointerId: 1, preventDefault: vi.fn() };
}

/** A drag carrying files, as the browser would present it. */
function drag(canvas: unknown, files: File[]) {
    return {
        target: canvas,
        preventDefault: vi.fn(),
        dataTransfer: { types: files.length ? ["Files"] : ["text/plain"], files, dropEffect: "" }
    };
}

describe("files dropped on the screen", () => {
    let canvas: ReturnType<typeof element>;
    let window: ReturnType<typeof element>;
    let saved: unknown;

    beforeEach(() => {
        canvas = element();
        window = element();
        saved = globalThis.window;
        // The clock never runs here: frames are stepped by hand, if at all.
        Object.assign(globalThis, { window, requestAnimationFrame: () => 0, cancelAnimationFrame: () => {} });
    });

    afterEach(() => {
        Object.assign(globalThis, { window: saved });
        vi.restoreAllMocks();
    });

    function started(app: Pick<App, "drop">, options: { drop?: boolean; pointer?: boolean } = {}) {
        const host = new BrowserHost({ canvas: canvas as never, audio: false, gamepads: false, ...options });
        const runtime = boot({ host });
        runtime.run({ update: () => {}, ...app });
        return { host, runtime };
    }

    it("marks the screen while a file is over it, and unmarks it after", () => {
        started({});

        const event = drag(canvas, [new File(["x"], "a.png")]);
        canvas.fire("dragover", event);
        expect(canvas.dataset.drop).toBe("over");
        expect(event.preventDefault).toHaveBeenCalled();
        expect(event.dataTransfer.dropEffect).toBe("copy");

        canvas.fire("dragleave", {});
        expect(canvas.dataset.drop).toBeUndefined();
    });

    it("hands the app the file, and releases the URL once it has finished", async () => {
        const revoke = vi.spyOn(URL, "revokeObjectURL");
        let seen: readonly DroppedFile[] = [];
        let released = false;

        started({
            drop: async (_ctx, files) => {
                seen = files;
                await Promise.resolve();
                // Still readable while the handler runs.
                released = revoke.mock.calls.length > 0;
            }
        });

        canvas.fire("drop", drag(canvas, [new File(["hello"], "photo.png", { type: "image/png" })]));
        await vi.waitFor(() => expect(revoke).toHaveBeenCalled());

        expect(seen).toHaveLength(1);
        expect(seen[0].name).toBe("photo.png");
        expect(seen[0].type).toBe("image/png");
        expect(seen[0].size).toBe(5);
        expect(seen[0].url).toMatch(/^blob:/);
        expect(released).toBe(false);
        expect(revoke).toHaveBeenCalledWith(seen[0].url);
    });

    it("reads a dropped file as bytes or as text", async () => {
        let seen: readonly DroppedFile[] = [];
        started({ drop: async (_ctx, files) => { seen = files; await files[0].text(); } });

        canvas.fire("drop", drag(canvas, [new File(["MML"], "song.txt")]));
        await vi.waitFor(() => expect(seen).toHaveLength(1));

        expect(await seen[0].text()).toBe("MML");
        expect([...(await seen[0].bytes())]).toEqual([77, 77, 76]);
    });

    it("lets a drag that carries no files alone", () => {
        started({ drop: () => { throw new Error("should not have been called"); } });

        const event = drag(canvas, []);
        canvas.fire("dragover", event);
        canvas.fire("drop", event);
        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(canvas.dataset.drop).toBeUndefined();
    });

    it("refuses a drop that misses the screen rather than letting the page navigate away", () => {
        started({});

        const elsewhere = drag({}, [new File(["x"], "a.png")]);
        window.fire("drop", elsewhere);
        expect(elsewhere.preventDefault).toHaveBeenCalled();
        expect(elsewhere.dataTransfer.dropEffect).toBe("none");
    });

    it("binds nothing when the host was told not to", () => {
        const before = canvas.bound;
        started({}, { drop: false, pointer: false });
        expect(canvas.bound).toBe(before);
    });

    it("unbinds everything on stop", () => {
        const { host } = started({});
        expect(canvas.bound).toBeGreaterThan(0);
        canvas.fire("dragover", drag(canvas, [new File(["x"], "a.png")]));

        host.stop();
        expect(canvas.bound).toBe(0);
        expect(window.bound).toBe(0);
        expect(canvas.dataset.drop).toBeUndefined();
    });
});

describe("the mouse", () => {
    let canvas: ReturnType<typeof element>;
    let window: ReturnType<typeof element>;
    let saved: unknown;

    beforeEach(() => {
        canvas = element();
        window = element();
        saved = globalThis.window;
        Object.assign(globalThis, { window, requestAnimationFrame: () => 0, cancelAnimationFrame: () => {} });
    });

    afterEach(() => {
        Object.assign(globalThis, { window: saved });
        vi.restoreAllMocks();
    });

    /**
     * A running machine with one frame already shown, since it is the frame
     * that tells the host where the picture landed.
     *
     * The canvas here is 256x212 and a frame is 272x228, borders included, so
     * the host draws it at scale 1 overlapping the edges - which puts screen
     * pixel 0,0 exactly at client 0,0 and makes the arithmetic below readable.
     */
    function started() {
        const host = new BrowserHost({ canvas: canvas as never, audio: false, gamepads: false });
        const runtime = boot({ host });
        runtime.run({ update: () => {} });
        runtime.step(1);
        return { host, runtime };
    }

    it("reports the position in the machine's own pixels", () => {
        const { runtime } = started();

        canvas.fire("pointermove", pointer(40, 100));
        expect(runtime.pointer.x).toBe(40);
        expect(runtime.pointer.y).toBe(100);
        expect(runtime.pointer.inside).toBe(true);
        expect(runtime.pointer.present).toBe(true);
    });

    it("undoes the page's own scaling of the canvas", () => {
        const { runtime } = started();
        // The page is showing the canvas at half its pixel size.
        canvas.rect = { left: 10, top: 20, width: 128, height: 106 };

        canvas.fire("pointermove", pointer(10 + 20, 20 + 50));
        expect(runtime.pointer.x).toBe(40);
        expect(runtime.pointer.y).toBe(100);
    });

    it("says when the pointer is beside the picture rather than on it", () => {
        const { runtime } = started();

        // The border the VDP draws is part of the frame but not of the screen.
        canvas.fire("pointermove", pointer(300, 100));
        expect(runtime.pointer.x).toBe(300);
        expect(runtime.pointer.inside).toBe(false);

        canvas.fire("pointerleave", {});
        expect(runtime.pointer.inside).toBe(false);
    });

    it("latches a press so it reads as new for exactly one frame", () => {
        const { runtime } = started();

        canvas.fire("pointerdown", pointer(10, 10));
        expect(runtime.pointer.pressed()).toBe(true);
        expect(runtime.pointer.down()).toBe(true);

        runtime.step(1);
        expect(runtime.pointer.pressed()).toBe(false);
        expect(runtime.pointer.down()).toBe(true);

        canvas.fire("pointerup", pointer(10, 10));
        expect(runtime.pointer.released()).toBe(true);
        runtime.step(1);
        expect(runtime.pointer.released()).toBe(false);
    });

    it("keeps following a drag that leaves the screen, by capturing the pointer", () => {
        const { runtime } = started();

        canvas.fire("pointerdown", pointer(100, 100));
        expect(canvas.captured.has(1)).toBe(true);

        canvas.fire("pointermove", pointer(-40, 300));
        expect(runtime.pointer.x).toBe(-40);
        expect(runtime.pointer.down()).toBe(true);

        canvas.fire("pointerup", pointer(-40, 300));
        expect(canvas.captured.size).toBe(0);
        expect(runtime.pointer.down()).toBe(false);
    });

    it("lets go of the buttons when the pointer is taken away", () => {
        const { runtime } = started();

        canvas.fire("pointerdown", pointer(10, 10));
        canvas.fire("pointercancel", {});
        expect(runtime.pointer.down()).toBe(false);

        canvas.fire("pointerdown", pointer(10, 10));
        window.fire("blur", {});
        expect(runtime.pointer.down()).toBe(false);
    });

    it("reports nothing before a frame has been shown, since it cannot yet know where", () => {
        const host = new BrowserHost({ canvas: canvas as never, audio: false, gamepads: false });
        const runtime = boot({ host });
        runtime.run({ update: () => {} });

        canvas.fire("pointermove", pointer(40, 100));
        expect(runtime.pointer.present).toBe(false);
    });
});
