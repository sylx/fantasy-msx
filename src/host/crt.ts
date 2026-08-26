// A tube for the picture to arrive on.
//
// The frame goes to the GPU as a texture and one quad puts it back on the
// canvas through a fragment shader: scanlines, bloom, an RGB fringe, a curved
// tube, a vignette and a mains flicker. Nothing here touches the machine - the
// V9938 has already finished with the frame by the time this sees it, and the
// pixels underneath are exactly the ones it drew. This is the glass in front.
//
// The shader is WebGL CRT Shader by Matt Sephton (@gingerbeardman), itself a
// LOVE2D shader converted to GLSL, and used under its licence:
//
//     Copyright (c) 2025 Matt Sephton @gingerbeardman
//     MIT - https://github.com/gingerbeardman/webgl-crt-shader
//
// The maths below is his. What is different here is that it is
// written as WebGL2 GLSL directly rather than assembled at runtime out of the
// three.js version, and that it samples the frame at its own size out of the
// VDP's own canvas - so the magnification is the GPU's, and `sampleSource`
// below is where the modes are told apart.

/** Everything the shader will listen to. Ranges are what the sliders upstream use. */
export interface CrtParams {
    /** Off passes the frame through untouched. The context stays, so it is free to flip. */
    enabled: boolean;
    /**
     * Magnify with a plain filter. Off by default, which keeps pixel edges
     * hard wherever the magnification is a whole number and crosses over one
     * screen pixel where it is not - the 512-column modes on a canvas with no
     * whole number of pixels to give them.
     */
    smoothing: boolean;
    /** How dark the gaps between lines go. 0 to 1. */
    scanlineIntensity: number;
    /**
     * How many dark lines to lay across the picture. `"auto"` - the default -
     * uses the frame's own height, so one gap falls between each pair of the
     * machine's own scanlines however large the canvas is.
     */
    scanlineCount: number | "auto";
    /** Slowly varies the scanline depth down the screen, the way a real mask does. 0 to 1. */
    adaptiveIntensity: number;
    /** 0.6 to 1.8. Applied before contrast, and to the bloom tap. */
    brightness: number;
    /** 0.6 to 1.8, around mid grey. */
    contrast: number;
    /** 0 is greyscale, 1 leaves it alone, 2 is lurid. */
    saturation: number;
    /** How much the bright parts bleed into their neighbours. 0 to 1.5. */
    bloomIntensity: number;
    /** Luminance a pixel must reach before it blooms at all. 0 to 1. */
    bloomThreshold: number;
    /** Red and blue pulled apart horizontally, as a badly converged tube does. 0 to 1. */
    rgbShift: number;
    /** How far the corners fall off. 0 to 2. */
    vignetteStrength: number;
    /** How far the glass bulges. 0 to 0.5. Beyond the edge is black. */
    curvature: number;
    /** Mains hum in the brightness, at 110 radians a second. 0 to 0.15. */
    flickerStrength: number;
    /** Shifts the scanline phase down the screen. Wind it to roll the picture. */
    yOffset: number;
}

/**
 * What the machine arrives on, as an app sees it.
 *
 *     ctx.crt?.set({ curvature: 0.2, scanlineIntensity: 0.5 });
 *     ctx.crt.enabled = false;              // a menu wants a flat screen
 *     ctx.crt.params.yOffset += 0.01;       // roll it, for a frame or two
 */
export interface Crt {
    /** The live values. Assign straight to them, or patch several with `set`. */
    readonly params: CrtParams;
    /** Patches several at once. Unmentioned parameters keep their value. */
    set(patch: Partial<CrtParams>): void;
    /** Back to what this display was created with. */
    reset(): void;
    /** The same as `params.enabled`, which is the one worth reaching for. */
    enabled: boolean;
}

/**
 * The upstream defaults, with three changed for what this machine puts out.
 *
 * A V9938 frame is already full range, where the demo upstream feeds the
 * shader a dim animation: brightness comes down from 1.5, and the bloom and
 * the fringe with it. `smoothing` is off because everything else in this
 * project draws a pixel as a pixel, and `scanlineCount` follows the frame.
 */
export const CRT_DEFAULTS: Readonly<CrtParams> = Object.freeze({
    enabled: true,
    smoothing: false,
    scanlineIntensity: 0.35,
    scanlineCount: "auto",
    adaptiveIntensity: 0.3,
    brightness: 1.2,
    contrast: 1.05,
    saturation: 1.1,
    bloomIntensity: 0.8,
    bloomThreshold: 0.38,
    rgbShift: 0.5,
    vignetteStrength: 0.25,
    curvature: 0.05,
    flickerStrength: 0.03,
    yOffset: 0
});

export type CrtOptions = Partial<CrtParams>;

/**
 * A frame, and where in its image it actually is.
 *
 * The V9938 renders into one canvas of a fixed 544x456 whatever the mode, and
 * puts the picture in the top left of it: 272x228 for the 256-column modes,
 * 544x228 for the 512-column ones. So the image is not the picture, and
 * `crop` is the part of it that is.
 */
export interface CrtSource {
    /** The image to upload. In a browser the VDP has drawn into a real canvas. */
    image: TexImageSource;
    /** The whole image, in pixels. */
    width: number;
    height: number;
    /** The picture within it, in the same pixels. The whole image where left out. */
    crop?: { x: number; y: number; width: number; height: number };
}

/** Where on the canvas the picture goes, in canvas pixels, top-left origin. */
export interface CrtViewport {
    x: number;
    y: number;
    width: number;
    height: number;
}

const VERTEX_SOURCE = `#version 300 es
precision highp float;

// No buffers: four corners and their texture coordinates, indexed by vertex.
const vec2 CORNERS[4] = vec2[4](vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(-1.0, 1.0), vec2(1.0, 1.0));
const vec2 COORDS[4] = vec2[4](vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(0.0, 1.0), vec2(1.0, 1.0));

out vec2 vUv;

void main() {
    vUv = COORDS[gl_VertexID];
    gl_Position = vec4(CORNERS[gl_VertexID], 0.0, 1.0);
}
`;

const FRAGMENT_SOURCE = `#version 300 es
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform sampler2D uTexture;
uniform bool uEnabled;
// Where the picture is inside the image, and how far it is being magnified.
// All in the image's own pixels; the origin is already flipped for the
// upload, so it counts from the bottom the way a texture does.
uniform vec2 uTexSize;
uniform vec2 uCropOrigin;
uniform vec2 uCropSize;
uniform vec2 uMagnify;
uniform bool uSharp;
uniform float scanlineIntensity;
uniform float scanlineCount;
uniform float time;
uniform float yOffset;
uniform float brightness;
uniform float contrast;
uniform float saturation;
uniform float bloomIntensity;
uniform float bloomThreshold;
uniform float rgbShift;
uniform float adaptiveIntensity;
uniform float vignetteStrength;
uniform float curvature;
uniform float flickerStrength;

in vec2 vUv;
out vec4 fragColor;

const float PI = 3.14159265;
const vec3 LUMA = vec3(0.299, 0.587, 0.114);
const float BLOOM_THRESHOLD_FACTOR = 0.5;
const float BLOOM_FACTOR_MULT = 1.5;
const float RGB_SHIFT_SCALE = 0.005;
const float RGB_SHIFT_INTENSITY = 0.08;

/**
 * One picture pixel, from a picture that is a corner of a larger image.
 *
 * uv runs 0 to 1 over the picture, so everything downstream is in the
 * machine's own frame and none of it has to know that the VDP's canvas is
 * 544x456 whatever the mode.
 *
 * The magnification is per axis, which is what the 512-column modes need: a
 * SCREEN 7 frame is 544 picture pixels across where a SCREEN 5 one is 272, and
 * both land on the same width of canvas - so the columns come out half as wide
 * as the rows are tall. Where a magnification is a whole number, uSharp
 * samples texel centres and the pixels are hard. Where it is not - 544 columns
 * across 816 of canvas is one and a half each - it crosses from one texel to
 * the next over exactly one destination pixel, rather than keeping every other
 * column twice and leaving a stroke two pixels wide in one place and three in
 * the next. smoothing gives that up for a plain filter.
 */
vec4 sampleSource(vec2 uv) {
    vec2 texel = clamp(uv, 0.0, 1.0) * uCropSize;

    if (uSharp) {
        vec2 scale = max(uMagnify, vec2(1.0));
        vec2 base = floor(texel);
        vec2 offset = texel - base - 0.5;
        vec2 plateau = 0.5 - 0.5 / scale;
        texel = base + 0.5 + (offset - clamp(offset, -plateau, plateau)) * scale;
    }

    // Half a texel in from the picture's edge: the filter is on, and what is
    // outside the crop is the rest of the VDP's canvas rather than more picture.
    vec2 inside = clamp(texel, vec2(0.5), uCropSize - 0.5);
    return texture(uTexture, (uCropOrigin + inside) / uTexSize);
}

vec2 curveRemapUV(vec2 uv, float amount) {
    vec2 coords = uv * 2.0 - 1.0;
    float curveAmount = amount * 0.25;
    float dist = dot(coords, coords);
    coords = coords * (1.0 + dist * curveAmount);
    return coords * 0.5 + 0.5;
}

// A cross and its centre, normalised: five taps rather than nine. The radius
// is a fraction of the picture, so the bleed is the same width on the page in
// every mode rather than the same number of the VDP's columns.
vec4 sampleBloom(vec2 uv, float radius, vec4 centreSample) {
    vec2 o = vec2(radius);
    vec4 c = centreSample * 0.4;
    vec4 ring = (
        sampleSource(uv + vec2(o.x, 0.0)) +
        sampleSource(uv - vec2(o.x, 0.0)) +
        sampleSource(uv + vec2(0.0, o.y)) +
        sampleSource(uv - vec2(0.0, o.y))
    ) * 0.15;
    return c + ring;
}

// Chebyshev distance squared, which is a pow() the corners will not miss.
float vignetteApprox(vec2 uv, float strength) {
    vec2 vig = uv * 2.0 - 1.0;
    float dist = max(abs(vig.x), abs(vig.y));
    return 1.0 - dist * dist * strength;
}

void main() {
    vec2 uv = vUv;

    if (!uEnabled) {
        fragColor = sampleSource(uv);
        return;
    }

    if (curvature > 0.001) {
        uv = curveRemapUV(uv, curvature);
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
            fragColor = vec4(0.0, 0.0, 0.0, 1.0);
            return;
        }
    }

    vec4 pixel = sampleSource(uv);

    if (bloomIntensity > 0.001) {
        float pixelLum = dot(pixel.rgb, LUMA);
        if (pixelLum > bloomThreshold * BLOOM_THRESHOLD_FACTOR) {
            vec4 bloomSample = sampleBloom(uv, 0.005, pixel);
            bloomSample.rgb *= brightness;
            float bloomLum = dot(bloomSample.rgb, LUMA);
            float bloomFactor = bloomIntensity * max(0.0, (bloomLum - bloomThreshold) * BLOOM_FACTOR_MULT);
            pixel.rgb += bloomSample.rgb * bloomFactor;
        }
    }

    if (rgbShift > 0.005) {
        float shift = rgbShift * RGB_SHIFT_SCALE;
        pixel.r += sampleSource(vec2(uv.x + shift, uv.y)).r * RGB_SHIFT_INTENSITY;
        pixel.b += sampleSource(vec2(uv.x - shift, uv.y)).b * RGB_SHIFT_INTENSITY;
    }

    pixel.rgb *= brightness;

    float luminance = dot(pixel.rgb, LUMA);
    pixel.rgb = (pixel.rgb - 0.5) * contrast + 0.5;
    pixel.rgb = mix(vec3(luminance), pixel.rgb, saturation);

    // Scanlines, flicker and vignette are all one multiplication in the end.
    float lightingMask = 1.0;

    if (scanlineIntensity > 0.001) {
        float scanlineY = (uv.y + yOffset) * scanlineCount;
        float scanlinePattern = abs(sin(scanlineY * PI));

        float adaptiveFactor = 1.0;
        if (adaptiveIntensity > 0.001) {
            float yPattern = sin(uv.y * 30.0) * 0.5 + 0.5;
            adaptiveFactor = 1.0 - yPattern * adaptiveIntensity * 0.2;
        }

        lightingMask *= 1.0 - scanlinePattern * scanlineIntensity * adaptiveFactor;
    }

    if (flickerStrength > 0.001) {
        lightingMask *= 1.0 + sin(time * 110.0) * flickerStrength;
    }

    if (vignetteStrength > 0.001) {
        lightingMask *= vignetteApprox(uv, vignetteStrength);
    }

    pixel.rgb *= lightingMask;
    pixel.a = 1.0;

    fragColor = pixel;
}
`;

const UNIFORM_NAMES = [
    "uTexture", "uEnabled", "uTexSize", "uCropOrigin", "uCropSize", "uMagnify", "uSharp",
    "scanlineIntensity", "scanlineCount", "time", "yOffset",
    "brightness", "contrast", "saturation", "bloomIntensity", "bloomThreshold",
    "rgbShift", "adaptiveIntensity", "vignetteStrength", "curvature", "flickerStrength"
] as const;

type UniformName = (typeof UNIFORM_NAMES)[number];

/** `#rgb` or `#rrggbb` to three floats. Anything else is black, which is what a tube is. */
function toRgb(colour: string | undefined): [number, number, number] {
    const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((colour ?? "").trim());
    if (!match) return [0, 0, 0];
    const digits = match[1];
    const full = digits.length === 3 ? digits.replace(/./g, (d) => d + d) : digits;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as [number, number, number];
}

/**
 * The shader, a texture and a quad, on a canvas of its own.
 *
 * A canvas can only ever have one kind of context, so a display made here owns
 * the canvas: the 2D path in `BrowserHost` is not available on it afterwards.
 * That is why `enabled` is a uniform rather than a teardown - turning the
 * effect off leaves the same context drawing the same quad, and costs a pass
 * over the picture and nothing else.
 */
export class CrtDisplay implements Crt {
    readonly params: CrtParams;

    private readonly gl: WebGL2RenderingContext;
    private readonly program: WebGLProgram;
    private readonly vao: WebGLVertexArrayObject;
    private readonly uniforms: Record<UniformName, WebGLUniformLocation | null>;
    private readonly texture: WebGLTexture;
    private readonly defaults: CrtParams;
    private readonly started = performance.now();
    /** What the texture was last given, so a same-sized frame is a sub-image. */
    private textureWidth = 0;
    private textureHeight = 0;
    /** The filter currently on the texture, so `smoothing` can be set from anywhere. */
    private filter: number | null = null;
    private disposed = false;

    /**
     * Takes the canvas, or returns null where WebGL2 is not to be had - which
     * is a host's cue to fall back to drawing the frame itself.
     */
    static create(canvas: HTMLCanvasElement, options: CrtOptions = {}): CrtDisplay | null {
        try {
            return new CrtDisplay(canvas, options);
        } catch (error) {
            console.warn("CRT display unavailable, falling back to a plain canvas:", error);
            return null;
        }
    }

    constructor(canvas: HTMLCanvasElement, options: CrtOptions = {}) {
        const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false });
        if (!gl) throw new Error("could not get a webgl2 context for the display canvas");
        this.gl = gl;

        this.defaults = { ...CRT_DEFAULTS, ...options };
        this.params = { ...this.defaults };

        this.program = this.link(VERTEX_SOURCE, FRAGMENT_SOURCE);
        const vao = gl.createVertexArray();
        if (!vao) throw new Error("could not create a vertex array for the CRT quad");
        this.vao = vao;

        this.uniforms = {} as Record<UniformName, WebGLUniformLocation | null>;
        for (const name of UNIFORM_NAMES) this.uniforms[name] = gl.getUniformLocation(this.program, name);

        const texture = gl.createTexture();
        if (!texture) throw new Error("could not create a texture for the CRT");
        this.texture = texture;

        // The frame arrives top row first and the quad's origin is at the
        // bottom, so the upload flips it and the picture comes out upright.
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        // A frame is not a power of two and it must not wrap: the RGB fringe
        // and the bloom both sample past the edge.
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        this.applyFilter();
    }

    get enabled(): boolean {
        return this.params.enabled;
    }

    set enabled(value: boolean) {
        this.params.enabled = value;
    }

    set(patch: Partial<CrtParams>): void {
        Object.assign(this.params, patch);
    }

    reset(): void {
        Object.assign(this.params, this.defaults);
    }

    /**
     * Puts one frame on the tube.
     *
     * The picture goes up as a texture at the size the VDP drew it and the GPU
     * does the magnification, so `view` decides how large it comes out and the
     * shader works out from the two how far each axis is being stretched. That
     * is what tells the modes apart: a 256-column frame is magnified the same
     * amount both ways, and a 512-column one - whose pixels really are half as
     * wide - twice as far down the screen as across it.
     *
     * Everything outside `view` is cleared to `background`, so the curve and
     * the vignette stop at the edge of the picture rather than bending the
     * letterbox with it.
     */
    present(source: CrtSource, view: CrtViewport, background?: string): void {
        if (this.disposed) return;
        const gl = this.gl;
        const { drawingBufferWidth: bufferWidth, drawingBufferHeight: bufferHeight } = gl;

        const [r, g, b] = toRgb(background);
        gl.disable(gl.SCISSOR_TEST);
        gl.viewport(0, 0, bufferWidth, bufferHeight);
        gl.clearColor(r, g, b, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);

        const { width, height } = source;
        const crop = source.crop ?? { x: 0, y: 0, width, height };
        if (width <= 0 || height <= 0) return;
        if (crop.width <= 0 || crop.height <= 0 || view.width <= 0 || view.height <= 0) return;

        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        this.applyFilter();
        if (width !== this.textureWidth || height !== this.textureHeight) {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source.image);
            this.textureWidth = width;
            this.textureHeight = height;
        } else {
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source.image);
        }

        // GL counts rows from the bottom; the viewport arrives counted from the top.
        gl.viewport(view.x, bufferHeight - view.y - view.height, view.width, view.height);

        gl.useProgram(this.program);
        gl.bindVertexArray(this.vao);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.texture);

        const p = this.params;
        const u = this.uniforms;
        gl.uniform1i(u.uTexture, 0);
        gl.uniform1i(u.uEnabled, p.enabled ? 1 : 0);
        // The upload flipped the image, so the crop counts from the bottom too.
        gl.uniform2f(u.uTexSize, width, height);
        gl.uniform2f(u.uCropOrigin, crop.x, height - crop.y - crop.height);
        gl.uniform2f(u.uCropSize, crop.width, crop.height);
        gl.uniform2f(u.uMagnify, view.width / crop.width, view.height / crop.height);
        gl.uniform1i(u.uSharp, p.smoothing ? 0 : 1);
        gl.uniform1f(u.scanlineIntensity, p.scanlineIntensity);
        gl.uniform1f(u.scanlineCount, p.scanlineCount === "auto" ? crop.height : p.scanlineCount);
        gl.uniform1f(u.time, (performance.now() - this.started) / 1000);
        gl.uniform1f(u.yOffset, p.yOffset);
        gl.uniform1f(u.brightness, p.brightness);
        gl.uniform1f(u.contrast, p.contrast);
        gl.uniform1f(u.saturation, p.saturation);
        gl.uniform1f(u.bloomIntensity, p.bloomIntensity);
        gl.uniform1f(u.bloomThreshold, p.bloomThreshold);
        gl.uniform1f(u.rgbShift, p.rgbShift);
        gl.uniform1f(u.adaptiveIntensity, p.adaptiveIntensity);
        gl.uniform1f(u.vignetteStrength, p.vignetteStrength);
        gl.uniform1f(u.curvature, p.curvature);
        gl.uniform1f(u.flickerStrength, p.flickerStrength);

        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindVertexArray(null);
    }

    /** Blanks the canvas, for a frame that never came. */
    clear(background?: string): void {
        if (this.disposed) return;
        const gl = this.gl;
        const [r, g, b] = toRgb(background);
        gl.disable(gl.SCISSOR_TEST);
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.clearColor(r, g, b, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
    }

    /** Gives the GPU resources back. The context itself stays on the canvas. */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        const gl = this.gl;
        gl.deleteTexture(this.texture);
        gl.deleteVertexArray(this.vao);
        gl.deleteProgram(this.program);
    }

    /**
     * The filter stays on whatever `smoothing` says.
     *
     * Hard pixels are the shader's doing rather than the sampler's: `uSharp`
     * lands on texel centres wherever the magnification is a whole number, and
     * needs the filter to blend where it is not. `NEAREST` could not do the
     * second, and would bring the ragged columns back with it.
     */
    private applyFilter(): void {
        const gl = this.gl;
        if (this.filter === gl.LINEAR) return;
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        this.filter = gl.LINEAR;
    }

    private link(vertexSource: string, fragmentSource: string): WebGLProgram {
        const gl = this.gl;
        const vertex = this.compile(gl.VERTEX_SHADER, vertexSource);
        const fragment = this.compile(gl.FRAGMENT_SHADER, fragmentSource);
        const program = gl.createProgram();
        if (!program) throw new Error("could not create the CRT program");

        gl.attachShader(program, vertex);
        gl.attachShader(program, fragment);
        gl.linkProgram(program);
        // The shaders are the program's now; the objects themselves are done with.
        gl.deleteShader(vertex);
        gl.deleteShader(fragment);

        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            const log = gl.getProgramInfoLog(program);
            gl.deleteProgram(program);
            throw new Error(`could not link the CRT program: ${log ?? "no log"}`);
        }
        return program;
    }

    private compile(type: number, source: string): WebGLShader {
        const gl = this.gl;
        const shader = gl.createShader(type);
        if (!shader) throw new Error("could not create a CRT shader");

        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const log = gl.getShaderInfoLog(shader);
            gl.deleteShader(shader);
            throw new Error(`could not compile a CRT shader: ${log ?? "no log"}`);
        }
        return shader;
    }
}
