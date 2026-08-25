// Does the whole hechima stack run outside a browser?
//
// This matters more than it looks. The console has 253 tests and a set of
// screenshot tools that all run headless under vite-node, and an IME that only
// exists in a browser would be an IME no test could ever look at. EMBEDDING.md
// distributes the engine as a Web Worker script, so the first answer is no:
// `new Worker(...)` under node's worker_threads dies on `self is not defined`.
//
// But the seams are structural. `HechimaWorkerLike` in hechima.d.ts is just
// postMessage plus addEventListener, and the worker script is a plain UMD
// bundle. So the question is only how much of a Web Worker global scope has to
// be faked, and the answer turns out to be this file: self, importScripts, a
// fetch that reads from disk, and nothing else.
//
//   node spike/hechima/node-probe.mjs
//
// Learning is off because it wants OPFS, which is the one thing here that has
// no obvious answer outside a browser. Conversion does not need it.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const VENDOR = fileURLToPath(new URL("./vendor/", import.meta.url));
const HECHIMA = VENDOR + "hechima/";
const WASM = VENDOR + "hechima-wasm/";

/**
 * A Web Worker global scope, big enough for an Emscripten bundle. Returns
 * something `Hechima.connectWorker` will accept: the interface it wants is
 * two methods, and a real `Worker` is only one way to have them.
 */
function fakeWorker(script) {
    const listeners = [];
    const scope = {
        console, WebAssembly, TextDecoder, TextEncoder, URL, Date, Math, JSON,
        setTimeout, clearTimeout, setInterval, clearInterval, performance, crypto,

        // The wasm glue asks for its own two files by URL. Off a disk they are
        // files, and the streaming path fails over to ArrayBuffer by itself.
        fetch: async (url) => {
            const bytes = readFileSync(WASM + String(url).split("/").pop());
            return {
                ok: true, status: 200, headers: { get: () => null }, body: null,
                arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
            };
        },

        // The worker's side of the pipe. Whatever it posts is delivered to
        // whoever called addEventListener on the object below.
        postMessage: (message) => { for (const fn of listeners) fn({ data: message }); },
        addEventListener: () => {},
        location: { href: "file://" + HECHIMA + "hechima-worker.js" },

        importScripts: (...names) => {
            for (const name of names) {
                const file = name.includes("/") ? WASM + name.split("/").pop() : HECHIMA + name;
                vm.runInContext(readFileSync(file, "utf8"), context, { filename: file });
            }
        }
    };
    scope.self = scope;
    scope.globalThis = scope;

    const context = vm.createContext(scope);
    vm.runInContext(readFileSync(script, "utf8"), context, { filename: script });

    return {
        postMessage: (message) => scope.onmessage?.({ data: message }),
        addEventListener: (_type, listener) => listeners.push(listener)
    };
}

/** Loads a UMD bundle and hands back what it registered on the global. */
function umd(file, name) {
    const scope = { console, TextDecoder, TextEncoder, setTimeout, clearTimeout, performance, crypto };
    scope.self = scope;
    scope.window = scope;
    scope.globalThis = scope;
    vm.runInContext(readFileSync(file, "utf8"), vm.createContext(scope), { filename: file });
    return scope[name];
}

const Hechima = umd(HECHIMA + "hechima.js", "Hechima");
console.log(`hechima ${Hechima.version}, in node ${process.version}\n`);

const started = Date.now();
const conn = Hechima.connectWorker(fakeWorker(HECHIMA + "hechima-worker.js"), { maxCands: 9 });
const ready = await conn.init({
    wasmJs: "../hechima-wasm/hechima-wasm.js",
    dataUrl: "../hechima-wasm/mozc.data",
    learning: false                                  // OPFS, which node has not got
});
console.log(`ready in ${Date.now() - started}ms: ${JSON.stringify(ready)}\n`);

// The session layer on top, driven with plain records exactly as
// runtime/keyboard.ts produces them.
const shown = [];
let committed = "";
const fep = Hechima.createFep({
    show: (segments) => shown.push(segments),
    hide: () => {},
    commit: (text) => { committed += text; },
    ...conn.callbacks()
});
fep.setActive(true);

const type = async (keys) => {
    for (const [key, code] of keys) fep.feed({ key, code });
    await new Promise((r) => setTimeout(r, 200));    // the worker answers off-thread
};

await type([["n", "KeyN"], ["i", "KeyI"], ["h", "KeyH"], ["o", "KeyO"], ["n", "KeyN"], ["g", "KeyG"], ["o", "KeyO"],
            ["n", "KeyN"], ["y", "KeyY"], ["u", "KeyU"], ["u", "KeyU"], ["r", "KeyR"], ["y", "KeyY"], ["o", "KeyO"],
            ["k", "KeyK"], ["u", "KeyU"]]);
console.log(`yomi:  ${shown.at(-1).map((s) => s.text).join("")}`);

await type([[" ", "Space"]]);
console.log("segments after Space:");
for (const segment of shown.at(-1)) {
    console.log(`  ${segment.kind.padEnd(5)} ${JSON.stringify(segment.text)}`
        + (segment.candidates ? `  candidates ${JSON.stringify(segment.candidates)}` : ""));
}

await type([["Enter", "Enter"]]);
console.log(`\ncommitted: ${JSON.stringify(committed)}`);
console.log(committed === "日本語入力" ? "\nOK - the whole stack runs headless." : "\nunexpected result");
process.exit(0);
