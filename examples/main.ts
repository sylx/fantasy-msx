// Browser entry point: start the game, and give a touch screen something to
// press, since the machine only understands a joystick.

import { BUTTON, run, type Button } from "../src/index.js";
import { game } from "./game.js";

const runtime = run(game, { canvas: document.querySelector("canvas") as HTMLCanvasElement });

const TOUCH_BUTTONS: Record<string, Button> = {
    up: BUTTON.UP, down: BUTTON.DOWN, left: BUTTON.LEFT, right: BUTTON.RIGHT,
    a: BUTTON.A, b: BUTTON.B
};

for (const element of document.querySelectorAll<HTMLElement>("[data-button]")) {
    const button = TOUCH_BUTTONS[element.dataset.button ?? ""];
    if (button === undefined) continue;

    const press = (down: boolean) => (event: Event) => {
        event.preventDefault();
        runtime.input.setButton(button, down);
    };
    element.addEventListener("pointerdown", press(true));
    element.addEventListener("pointerup", press(false));
    element.addEventListener("pointercancel", press(false));
    element.addEventListener("pointerleave", press(false));
    element.addEventListener("contextmenu", (event) => event.preventDefault());
}
