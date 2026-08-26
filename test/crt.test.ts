// The CRT, driven against a WebGL2 context made of nothing.
//
// Node has no GPU and vitest has no canvas, so the context here records what
// it was told rather than drawing anything. What that pins down is the part
// that is easy to get wrong and impossible to see in a screenshot: which
// uniforms the parameters reach, and where on the canvas the quad lands -
// GL counts rows from the bottom and `present` is handed a top-left origin.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserHost, CRT_DEFAULTS, boot, type CrtOptions, type CrtSource, type Runtime } from "../src/index.js";
import type { Frame } from "../src/core/machine.js";

/** Enough of WebGL2 to link a program and draw a quad, and a note of it all. */
function gl2() {
    const uniforms: Record<string, number> = {};
    const pairs: Record<string, [number, number]> = {};
    const viewports: Array<[number, number, number, number]> = [];
    const filters: number[] = [];
    const clears: Array<[number, number, number, number]> = [];
    const deleted: string[] = [];

    return {
        // Only the constants this code reaches for; distinct values so a
        // mix-up between them shows up rather than passing by luck.
        TEXTURE_2D: 1, RGBA: 2, UNSIGNED_BYTE: 3, CLAMP_TO_EDGE: 4,
        TEXTURE_WRAP_S: 5, TEXTURE_WRAP_T: 6, TEXTURE_MIN_FILTER: 7, TEXTURE_MAG_FILTER: 8,
        LINEAR: 9, NEAREST: 10, VERTEX_SHADER: 11, FRAGMENT_SHADER: 12,
        COMPILE_STATUS: 13, LINK_STATUS: 14, COLOR_BUFFER_BIT: 15, SCISSOR_TEST: 16,
        TRIANGLE_STRIP: 17, TEXTURE0: 18,
        drawingBufferWidth: 0, drawingBufferHeight: 0,

        uniforms, pairs, viewports, filters, clears, deleted,
        draws: 0,
        uploads: { full: 0, sub: 0 },

        createShader: () => ({}),
        shaderSource() {},
        compileShader() {},
        getShaderParameter: () => true,
        getShaderInfoLog: () => "",
        deleteShader() {},
        createProgram: () => ({}),
        attachShader() {},
        linkProgram() {},
        getProgramParameter: () => true,
        getProgramInfoLog: () => "",
        deleteProgram: () => deleted.push("program"),
        // The name is the location, so a uniform can be read back by name.
        getUniformLocation: (_program: unknown, name: string) => name,
        createVertexArray: () => ({}),
        deleteVertexArray: () => deleted.push("vao"),
        bindVertexArray() {},
        createTexture: () => ({}),
        deleteTexture: () => deleted.push("texture"),
        bindTexture() {},
        activeTexture() {},
        pixelStorei() {},
        texParameteri(_target: number, name: number, value: number) {
            if (name === 7) filters.push(value);
        },
        texImage2D(...args: unknown[]) { if (args.length === 6) this.uploads.full++; },
        texSubImage2D() { this.uploads.sub++; },
        viewport(x: number, y: number, w: number, h: number) { viewports.push([x, y, w, h]); },
        clearColor(r: number, g: number, b: number, a: number) { clears.push([r, g, b, a]); },
        clear() {},
        disable() {},
        useProgram() {},
        uniform1i(name: string, value: number) { uniforms[name] = value; },
        uniform1f(name: string, value: number) { uniforms[name] = value; },
        uniform2f(name: string, x: number, y: number) { pairs[name] = [x, y]; },
        drawArrays() { this.draws++; }
    };
}

type FakeGl = ReturnType<typeof gl2>;

/** A canvas that hands out whichever context it has been told it has. */
function element(width: number, height: number, webgl: FakeGl | null) {
    const flat = { imageSmoothingEnabled: false, imageSmoothingQuality: "low", fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn() };
    return {
        width, height, flat,
        dataset: {} as Record<string, string | undefined>,
        getContext(kind: string) {
            if (kind === "webgl2") {
                if (!webgl) return null;
                webgl.drawingBufferWidth = width;
                webgl.drawingBufferHeight = height;
                return webgl;
            }
            return flat;
        },
        getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
        addEventListener() {}, removeEventListener() {}
    };
}

/**
 * A finished frame, as the VDP would hand one over: the picture in the corner
 * of one canvas of a fixed size, whatever the mode.
 *
 *     SCREEN 5 and 8   272 x 228 of it
 *     SCREEN 6 and 7   544 x 228 of it
 */
const CANVAS_WIDTH = (256 + 8 * 2) * 2;
const CANVAS_HEIGHT = (212 + 8 * 2) * 2;

function frame(width: number, height: number): Frame {
    return { source: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT }, width, height } as Frame;
}

/** The same, as `present` takes it. */
function picture(width: number, height: number): CrtSource {
    return {
        image: {} as never, width: CANVAS_WIDTH, height: CANVAS_HEIGHT,
        crop: { x: 0, y: 0, width, height }
    };
}

describe("the CRT", () => {
    let saved: unknown;

    beforeEach(() => {
        saved = globalThis.window;
        Object.assign(globalThis, {
            window: { addEventListener() {}, removeEventListener() {} },
            requestAnimationFrame: () => 0,
            cancelAnimationFrame: () => {}
        });
    });

    afterEach(() => {
        Object.assign(globalThis, { window: saved });
        vi.restoreAllMocks();
    });

    function host(canvas: ReturnType<typeof element>, crt: boolean | CrtOptions = true) {
        return new BrowserHost({ canvas: canvas as never, audio: false, gamepads: false, drop: false, pointer: false, crt });
    }

    it("is off unless asked for, and then the canvas keeps its 2d context", () => {
        const canvas = element(800, 621, gl2());
        const flat = new BrowserHost({ canvas: canvas as never, audio: false, gamepads: false });

        expect(flat.crt).toBeNull();
        flat.present(frame(272, 228), 1);
        expect(canvas.flat.drawImage).toHaveBeenCalled();
    });

    it("reaches the app through the runtime and the context alike", () => {
        const canvas = element(800, 621, gl2());
        let seen: Runtime["crt"] = null;
        const runtime = boot({ host: host(canvas) });
        runtime.run({ init: (ctx) => { seen = ctx.crt; }, update: () => {} });

        expect(runtime.crt).not.toBeNull();
        expect(seen).toBe(runtime.crt);
        expect(runtime.crt?.params.enabled).toBe(true);
    });

    it("puts the quad where the picture is, counted from the bottom", () => {
        const context = gl2();
        const canvas = element(800, 621, context);
        // A 272x228 frame into 800x621 is a whole scale of 2: 544x456,
        // centred, which leaves 82 rows above it and 83 below - so the
        // viewport's y is not the same number counted either way round.
        host(canvas).present(frame(272, 228), 1);

        expect(context.viewports).toEqual([[0, 0, 800, 621], [128, 83, 544, 456]]);
        expect(context.draws).toBe(1);
    });

    it("clears the whole canvas to the background before narrowing to the picture", () => {
        const context = gl2();
        const canvas = element(800, 621, context);
        new BrowserHost({
            canvas: canvas as never, audio: false, gamepads: false, drop: false, pointer: false,
            crt: true, background: "#4080c0"
        }).present(frame(272, 228), 1);

        expect(context.clears).toEqual([[0x40 / 255, 0x80 / 255, 0xc0 / 255, 1]]);
        expect(context.viewports[0]).toEqual([0, 0, 800, 621]);
    });

    it("puts a 512-column mode on the same screen as a 256-column one", () => {
        const flat = gl2();
        const wide = gl2();
        // SCREEN 5 and SCREEN 7 on the same canvas. The 512-column modes get
        // their columns by halving the pixel rather than widening the picture,
        // so both fill the canvas the same way and neither is stretched.
        host(element(816, 684, flat)).present(frame(272, 228), 1);
        host(element(816, 684, wide)).present(frame(544, 228), 0.5);

        expect(flat.viewports[1]).toEqual([0, 0, 816, 684]);
        expect(wide.viewports[1]).toEqual([0, 0, 816, 684]);
    });

    it("tells the shader how far each axis is being stretched", () => {
        const flat = gl2();
        const wide = gl2();
        host(element(816, 684, flat)).present(frame(272, 228), 1);
        host(element(816, 684, wide)).present(frame(544, 228), 0.5);

        // SCREEN 5: 272 columns and 228 rows into 816 x 684, three of each.
        expect(flat.pairs.uMagnify).toEqual([3, 3]);
        // SCREEN 7: the same 816 across, but 544 columns to fit in it - so the
        // columns are magnified half as far as the rows, which is what makes
        // its pixels tall rather than its picture wide.
        expect(wide.pairs.uMagnify).toEqual([1.5, 3]);
    });

    it("shows the picture out of the corner of the VDP's canvas, flipped", () => {
        const context = gl2();
        host(element(816, 684, context)).present(frame(272, 228), 1);

        // The canvas is 544x456 whatever the mode; a SCREEN 5 picture is the
        // top-left 272x228 of it. The upload flips the image, so the crop's
        // origin counts from the bottom: 456 - 0 - 228.
        expect(context.pairs.uTexSize).toEqual([544, 456]);
        expect(context.pairs.uCropSize).toEqual([272, 228]);
        expect(context.pairs.uCropOrigin).toEqual([0, 228]);
    });

    it("gives a 512-column frame the whole width of that canvas", () => {
        const context = gl2();
        host(element(816, 684, context)).present(frame(544, 228), 0.5);

        expect(context.pairs.uCropSize).toEqual([544, 228]);
        expect(context.pairs.uCropOrigin).toEqual([0, 228]);
    });

    it("follows the frame's own height for scanlines unless told a number", () => {
        const context = gl2();
        const display = host(element(800, 600, context)).crt!;

        display.present(picture(272, 228), { x: 0, y: 0, width: 816, height: 684 });
        expect(context.uniforms.scanlineCount).toBe(228);

        display.set({ scanlineCount: 400 });
        display.present(picture(272, 228), { x: 0, y: 0, width: 816, height: 684 });
        expect(context.uniforms.scanlineCount).toBe(400);
    });

    it("carries every parameter to a uniform of its own", () => {
        const context = gl2();
        const display = host(element(800, 600, context)).crt!;
        display.set({
            scanlineIntensity: 0.5, adaptiveIntensity: 0.4, brightness: 1.3, contrast: 1.1,
            saturation: 0.9, bloomIntensity: 0.6, bloomThreshold: 0.7, rgbShift: 0.8,
            vignetteStrength: 0.2, curvature: 0.3, flickerStrength: 0.05, yOffset: 0.25
        });
        display.present(picture(272, 228), { x: 0, y: 0, width: 816, height: 684 });

        expect(context.uniforms).toMatchObject({
            uEnabled: 1, uTexture: 0,
            scanlineIntensity: 0.5, adaptiveIntensity: 0.4, brightness: 1.3, contrast: 1.1,
            saturation: 0.9, bloomIntensity: 0.6, bloomThreshold: 0.7, rgbShift: 0.8,
            vignetteStrength: 0.2, curvature: 0.3, flickerStrength: 0.05, yOffset: 0.25
        });
    });

    it("takes a change between one frame and the next", () => {
        const context = gl2();
        const display = host(element(800, 600, context)).crt!;
        const view = { x: 0, y: 0, width: 816, height: 684 };

        display.present(picture(272, 228), view);
        expect(context.uniforms.uEnabled).toBe(1);

        // Straight onto the object, which is how an app would reach it.
        display.params.curvature = 0.42;
        display.enabled = false;
        display.present(picture(272, 228), view);
        expect(context.uniforms).toMatchObject({ uEnabled: 0, curvature: 0.42 });

        display.reset();
        display.present(picture(272, 228), view);
        expect(context.uniforms.uEnabled).toBe(1);
        expect(context.uniforms.curvature).toBe(CRT_DEFAULTS.curvature);
    });

    it("starts from the parameters it was given, and resets to those", () => {
        const context = gl2();
        const display = host(element(800, 600, context), { curvature: 0.25, smoothing: true }).crt!;

        expect(display.params.curvature).toBe(0.25);
        display.set({ curvature: 0 });
        display.reset();
        expect(display.params.curvature).toBe(0.25);
    });

    it("keeps the pixels hard itself, and leaves the filter alone", () => {
        const context = gl2();
        const display = host(element(800, 600, context)).crt!;
        const view = { x: 0, y: 0, width: 816, height: 684 };

        // The sampler filters either way - hard edges are the shader's doing,
        // because a NEAREST sampler could not resolve a 1.5x magnification.
        display.present(picture(272, 228), view);
        expect(context.filters).toEqual([context.LINEAR]);
        expect(context.uniforms.uSharp).toBe(1);

        display.params.smoothing = true;
        display.present(picture(272, 228), view);
        expect(context.filters).toEqual([context.LINEAR]);
        expect(context.uniforms.uSharp).toBe(0);
    });

    it("re-uploads the whole texture only when the image changes size", () => {
        const context = gl2();
        const display = host(element(800, 600, context)).crt!;
        const view = { x: 0, y: 0, width: 816, height: 684 };

        display.present(picture(272, 228), view);
        display.present(picture(272, 228), view);
        expect(context.uploads).toEqual({ full: 1, sub: 1 });

        // A mode change moves the crop, not the canvas the VDP draws into, so
        // it costs a sub-image like any other frame.
        display.present(picture(544, 228), view);
        expect(context.uploads).toEqual({ full: 1, sub: 2 });
    });

    it("draws nothing for a frame that never came, but still blanks the canvas", () => {
        const context = gl2();
        host(element(800, 600, context)).present(null, 1);

        expect(context.viewports).toEqual([[0, 0, 800, 600]]);
        expect(context.draws).toBe(0);
    });

    it("gives its GPU resources back when the host stops", () => {
        const context = gl2();
        const display = host(element(800, 600, context));
        display.stop();

        expect(context.deleted.sort()).toEqual(["program", "texture", "vao"]);
        // A stopped display is inert rather than broken.
        display.crt!.present(picture(272, 228), { x: 0, y: 0, width: 816, height: 684 });
        expect(context.draws).toBe(0);
    });

    it("says so and draws the frame itself where WebGL2 is not to be had", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const canvas = element(800, 600, null);
        const display = host(canvas);

        expect(display.crt).toBeNull();
        expect(warn).toHaveBeenCalled();

        display.present(frame(272, 228), 1);
        expect(canvas.flat.drawImage).toHaveBeenCalled();
    });
});
