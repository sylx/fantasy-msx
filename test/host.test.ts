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
        getContext: () => ({ imageSmoothingEnabled: false, fillRect() {}, drawImage() {} }),
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

    function started(app: Pick<App, "drop">, drop?: boolean) {
        const host = new BrowserHost({ canvas: canvas as never, audio: false, gamepads: false, drop });
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
        started({}, false);
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
