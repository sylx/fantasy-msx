// The launcher.
//
// Each example gets a machine of its own: switching stops the running one -
// which closes its audio device and drops its event listeners - and boots a
// fresh one. The chosen example lives in the URL fragment, so a link can point
// at one.

import { BUTTON, boot, type Button, type Runtime } from "../src/index.js";
import { EXAMPLES, findExample, type Example } from "./registry.js";

let canvas = document.querySelector("canvas") as HTMLCanvasElement;
const nav = document.querySelector("nav") as HTMLElement;
const summary = document.querySelector("#summary") as HTMLElement;
const controls = document.querySelector("#controls") as HTMLElement;

const CRT_KEY = "fantasy-msx.crt";

let runtime: Runtime | null = null;
let running: string | null = null;
let crt = localStorage.getItem(CRT_KEY) === "on";
/** Which kind of context the canvas on the page has been given, if any yet. */
let display: "flat" | "crt" | null = null;

// One button per example, marked so the current one reads as selected.
const buttons = new Map<string, HTMLButtonElement>();
for (const example of EXAMPLES) {
    const button = document.createElement("button");
    button.textContent = example.title;
    button.addEventListener("click", () => { location.hash = example.id; });
    nav.append(button);
    buttons.set(example.id, button);
}

// The tube, off by default. A canvas keeps the kind of context it was first
// given for life, so turning it on and off swaps the canvas for a fresh one
// and reboots - which is why this is a page decision rather than a game one.
// Everything else about the tube is live: see `runtime.crt`.
const crtButton = document.createElement("button");
crtButton.textContent = "CRT";
crtButton.title = "Scanlines, bloom and a curved tube";
crtButton.setAttribute("aria-pressed", String(crt));
crtButton.addEventListener("click", () => {
    crt = !crt;
    localStorage.setItem(CRT_KEY, crt ? "on" : "off");
    crtButton.setAttribute("aria-pressed", String(crt));
    void relaunch();
});
nav.append(crtButton);

/** The canvas to boot on, replaced where the context it needs is not the one it has. */
function displayCanvas(): HTMLCanvasElement {
    const wanted = crt ? "crt" : "flat";
    if (display !== null && display !== wanted) {
        const fresh = canvas.cloneNode(false) as HTMLCanvasElement;
        canvas.replaceWith(fresh);
        canvas = fresh;
    }
    display = wanted;
    return canvas;
}

/** Boots the running example again, from the top. */
async function relaunch(): Promise<void> {
    const id = running;
    if (id === null) return;
    running = null;
    await launch(findExample(id));
}

async function launch(example: Example): Promise<void> {
    if (running === example.id) return;
    running = example.id;

    runtime?.stop();
    for (const [id, button] of buttons) button.setAttribute("aria-current", String(id === example.id));
    summary.textContent = example.summary;
    controls.textContent = example.controls;

    const app = await example.load();
    // The fragment may have changed again while the module was loading.
    if (running !== example.id) return;

    runtime = boot({ canvas: displayCanvas(), crt });
    bindTouch(runtime);
    runtime.run(app);
}

/** Gives a touch screen something to press: the machine only knows a joystick. */
function bindTouch(target: Runtime): void {
    const mapping: Record<string, Button> = {
        up: BUTTON.UP, down: BUTTON.DOWN, left: BUTTON.LEFT, right: BUTTON.RIGHT,
        a: BUTTON.A, b: BUTTON.B
    };

    for (const element of document.querySelectorAll<HTMLElement>("[data-button]")) {
        const button = mapping[element.dataset.button ?? ""];
        if (button === undefined) continue;

        const press = (down: boolean) => (event: Event) => {
            event.preventDefault();
            target.input.setButton(button, down);
        };
        // Replacing the node drops the listeners bound to the previous runtime.
        const fresh = element.cloneNode(true) as HTMLElement;
        element.replaceWith(fresh);
        fresh.addEventListener("pointerdown", press(true));
        fresh.addEventListener("pointerup", press(false));
        fresh.addEventListener("pointercancel", press(false));
        fresh.addEventListener("pointerleave", press(false));
        fresh.addEventListener("contextmenu", (event) => event.preventDefault());
    }
}

window.addEventListener("hashchange", () => void launch(findExample(location.hash.slice(1))));
void launch(findExample(location.hash.slice(1)));
