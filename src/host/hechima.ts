// hechima: Mozc, in a Worker, behind the machine's own IME seam.
//
// The conversion engine is https://github.com/msonrm/hechima - Mozc built with
// Emscripten, wrapped in a session layer that has no UI of its own. That last
// part is why it is the right engine for this machine: what it hands back is a
// preedit and a list of candidates as data, and where they go on a 16-colour
// screen made of 16x16 cells is the machine's business.
//
// This file is the only place that knows hechima exists. Everything above it
// talks to `ImeSession`, which hechima's own `FepSession` satisfies as shipped -
// the adapter below is a rename of three fields and a promise.
//
// ## What it costs
//
// About 15MB over the wire, nearly all of it the dictionary, fetched once and
// cached by the browser thereafter. Nothing here fetches until `connectHechima`
// is called, so an app that never asks for Japanese never pays. `onProgress` is
// there to be drawn on the machine's own screen while it arrives.
//
// ## Where the files go
//
// The bundles are not vendored into this repository - they are 21.9MB and they
// belong to another project. `scripts/fetch-hechima.sh` puts them under
// `public/hechima/`, which vite copies into the build verbatim. Paths passed to
// the worker are resolved **relative to the worker script**, not to the page,
// which is what lets the whole thing work under a subpath like
// `sylx.github.io/fantasy-msx/` without knowing the prefix.

import type { ImeCallbacks, ImeSession, ImeSessionFactory, ImeSegment, KeyTap } from "../bios/ime.js";

export interface HechimaOptions {
    /**
     * Where the bundles live, as a URL the page can resolve. Defaults to
     * `hechima/` beside the document, which is where the fetch script puts them.
     */
    baseUrl?: string;
    /** Candidates asked for per clause. hechima's own default is 9. */
    maxCandidates?: number;
    /** Called while the dictionary comes down: about 13MB of it, once. */
    onProgress?: (loaded: number, total: number) => void;
    /**
     * Whether Mozc records what was chosen, and keeps it across visits in the
     * browser's origin-private filesystem. On by default, as hechima has it.
     */
    learning?: boolean;
}

/** What hechima registers on the global when its UMD bundle is loaded. */
interface HechimaGlobal {
    version: string;
    createFep(callbacks: unknown): unknown;
    connectWorker(worker: Worker, options?: unknown): {
        init(paths?: unknown): Promise<{ version: string; features: Record<string, boolean> }>;
        callbacks(): Record<string, unknown>;
    };
}

/** What `connectHechima` gives back, past the factory the machine wants. */
export interface HechimaConnection {
    /** Ready to hand to `ime.attach`. */
    readonly session: ImeSessionFactory;
    /** The engine's own version, worth recording: hechima breaks across layers. */
    readonly version: string;
    /** What the wasm build turned out to support - learning, clause resizing. */
    readonly features: Record<string, boolean>;
}

/**
 * Loads hechima, brings the engine up, and hands back a session factory.
 *
 * The promise settles when the dictionary is in memory and the first conversion
 * would answer - which is the moment an app should stop drawing a progress bar
 * and start letting people type.
 */
export async function connectHechima(options: HechimaOptions = {}): Promise<HechimaConnection> {
    if (typeof Worker !== "function") {
        throw new Error("hechima needs a browser: there is no Worker in this environment");
    }

    const base = options.baseUrl ?? "hechima/";
    const at = (path: string) => new URL(base + path, document.baseURI).href;

    await load(at("keymap-engine/keymap-engine.js"));
    await load(at("hechima/hechima.js"));
    const Hechima = (globalThis as { Hechima?: HechimaGlobal }).Hechima;
    if (!Hechima) throw new Error("hechima loaded but registered nothing - check the bundle");

    const worker = new Worker(at("hechima/hechima-worker.js"));
    // EMBEDDING.md is explicit about this: connectWorker does not watch for the
    // error event, so a worker that 404s leaves init() hanging with nothing said.
    let failed: ((reason: Error) => void) | null = null;
    const broke = new Promise<never>((_, reject) => { failed = reject; });
    worker.addEventListener("error", (event) => {
        failed?.(new Error(`hechima worker failed to load: ${event.message || at("hechima/hechima-worker.js")}`));
    });

    const connection = Hechima.connectWorker(worker, {
        maxCands: options.maxCandidates ?? 9,
        onProgress: options.onProgress
    });

    const ready = await Promise.race([
        connection.init({
            // Relative to the worker script, which is what makes a subpath work.
            wasmJs: "../hechima-wasm/hechima-wasm.js",
            dataUrl: "../hechima-wasm/mozc.data",
            learning: options.learning ?? true
        }),
        broke
    ]);

    return {
        version: Hechima.version,
        features: ready.features,
        session: (callbacks: ImeCallbacks): ImeSession => {
            const fep = Hechima.createFep({
                // hechima's SegmentView and our ImeSegment are the same record
                // under different ownership; the copy is what keeps them so.
                show: (segments: ImeSegment[]) => callbacks.show(segments.map(copy)),
                hide: () => callbacks.hide(),
                commit: (text: string) => callbacks.commit(text),
                ...connection.callbacks()
            }) as ImeSession;
            return fep;
        }
    };
}

function copy(segment: ImeSegment): ImeSegment {
    return {
        text: segment.text,
        kind: segment.kind,
        candidates: segment.candidates ? [...segment.candidates] : undefined,
        candidateIndex: segment.candidateIndex
    };
}

/** Loads a UMD bundle by script tag, once, and waits for it to register itself. */
const loaded = new Map<string, Promise<void>>();

function load(url: string): Promise<void> {
    const already = loaded.get(url);
    if (already) return already;

    const waiting = new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        script.src = url;
        script.async = false;
        script.addEventListener("load", () => resolve());
        script.addEventListener("error", () => reject(new Error(`could not load ${url}`)));
        document.head.append(script);
    });
    loaded.set(url, waiting);
    return waiting;
}

/** The shape of a keystroke hechima reads, which is ours unchanged. */
export type { KeyTap };
