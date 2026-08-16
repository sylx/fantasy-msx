// A canvas just real enough for the VDP to render into, outside a browser.
//
// VDP.initFrameResources() allocates its framebuffer as ImageData obtained from
// a 2D context, then blits it back with putImageData() once per frame. It never
// reads pixels back through the context, so an object holding the ImageData is
// a complete stand-in. Tests read the pixels straight off `imageData.data`.

export function createHeadlessCanvas(width = 0, height = 0) {
    const canvas = {
        width, height,
        // Set by putImageData, so hosts/tests can reach the rendered frame.
        imageData: null,
        getContext() { return context; }
    };

    const context = {
        canvas,
        createImageData(w, h) {
            return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
        },
        putImageData(imageData) {
            canvas.imageData = imageData;
        }
    };

    return canvas;
}

export function createHeadlessDocument() {
    return {
        createElement(tag) {
            if (tag === "canvas") return createHeadlessCanvas();
            throw new Error(`headless document cannot create <${tag}>`);
        }
    };
}
